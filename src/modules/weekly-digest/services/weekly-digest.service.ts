import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { PreferenceManagerService } from '@/modules/notifications/services/preference-manager.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type {
  ConsumerForDigest,
  WeeklyDigestPayload,
  WeeklyDigestResponseDto,
  WeeklyDigestRunReport,
} from '../dto/weekly-digest.dto';
import { WeeklyDigestRepository } from '../repositories/weekly-digest.repository';

import { DigestPayloadBuilderService } from './digest-payload-builder.service';

const DAILY_INSIGHTS_CATEGORY = 'daily-insights' as const;
const WEEKLY_DIGEST_RESOURCE = 'consumer_weekly_digest';
const SUBJECT = 'Your Weekly Health Summary';

/**
 * BE-54 — Weekly Digest service.
 *
 * One per-Consumer flow per call to `processConsumer`:
 *
 *   1. Honour notification preferences. If the consumer has opted
 *      out of the `daily-insights` category we skip the entire
 *      pipeline — no row, no notification.
 *
 *   2. Idempotency check on `(user_id, week_starting)`. A
 *      previously-created row aborts processing so we never
 *      double-send. The DB unique constraint is the safety net;
 *      this read is the cheap fast path.
 *
 *   3. Build the payload via the builder service, which talks to
 *      the injectable scan stats port.
 *
 *   4. Insert via `insertIfMissing` (returns null on conflict so
 *      a race between two schedulers is harmless).
 *
 *   5. Send the FCM notification through `NotificationsService`.
 *      We hand it `category: 'daily-insights'` so per-channel and
 *      per-category preferences both apply, and `priority: 'low'`
 *      so the consumer doesn't get a push in the middle of the
 *      night even if quiet hours are off (priority filter is
 *      handled inside notifications service).
 *
 *   6. Stamp `delivered_at` on success. Failures leave it null so
 *      the redelivery sweep can pick it up later — the row itself
 *      is the source of truth for "we tried".
 *
 * `runForWeek` orchestrates this across every active Consumer in
 * pages of 500. The cron job is the only public caller; the
 * service is exported so handoff modules and tests can drive it
 * directly.
 */
@Injectable()
export class WeeklyDigestService {
  /** Page size for the `users` walk inside `runForWeek`. */
  private readonly batchSize = 500;

  constructor(
    private readonly repo: WeeklyDigestRepository,
    private readonly payloadBuilder: DigestPayloadBuilderService,
    private readonly notifications: NotificationsService,
    private readonly preferences: PreferenceManagerService,
    private readonly logger: LoggerService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Compute the Monday that anchors the week we're summarising.
   *
   * The cron runs Sunday 08:00 IST, so "previous Monday (start of
   * last week)" is the Monday six days before today — i.e. the
   * start of the ISO week that's wrapping up today. The value is
   * returned as a UTC `Date` at IST-midnight; downstream code
   * converts to the `YYYY-MM-DD` string for the Postgres `date`
   * column via `toDateString`.
   *
   * Manual invocation on other weekdays follows the same rule:
   * we take the most recent Monday at-or-before today (Monday →
   * 0 days back, Tuesday → 1, …, Sunday → 6).
   *
   * Note: we read the calendar day from the *Asia/Kolkata*
   * timezone because the cron fires there. Pure UTC arithmetic
   * would shift the boundary by 5h30m and occasionally roll the
   * date back a day for users near midnight.
   */
  computePreviousMondayUtc(now: Date = new Date()): Date {
    const istParts = this.toIstDateParts(now);
    // ISO weekday in IST: Mon=1 ... Sun=7. We use Zeller's
    // congruence indirectly by asking JavaScript: build a UTC
    // Date that has the same Y/M/D as the IST calendar day and
    // read its day-of-week. Because UTC and IST share calendar
    // days at noon-ish, the Y/M/D we extracted from
    // `toIstDateParts` is unambiguous.
    const dowDate = new Date(Date.UTC(istParts.year, istParts.month - 1, istParts.day));
    const dow = ((dowDate.getUTCDay() + 6) % 7) + 1; // 1..7 (Mon..Sun)
    const daysBack = dow - 1;

    // Anchor returned at IST midnight expressed in UTC.
    const istMidnightUtcMs =
      Date.UTC(istParts.year, istParts.month - 1, istParts.day) - 5.5 * 60 * 60 * 1000;
    return new Date(istMidnightUtcMs - daysBack * 24 * 60 * 60 * 1000);
  }

  /** YYYY-MM-DD in IST for storage in the `date` column. */
  toDateString(d: Date): string {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${day}`;
  }

  /**
   * On-demand read for `GET /weekly-digest` (Mobile_App "Your week
   * with RADHA" screen). Returns the freshest digest the cron has
   * produced for this user; if none exists yet (brand-new account,
   * or the Sunday cron hasn't run), it builds the previous week's
   * digest on the fly and persists it so the screen is never empty
   * and the next cron run is idempotent.
   *
   * No notification is sent on this path — it's a pure read that
   * may lazily materialise a row.
   */
  async getDigestForUser(
    userId: string,
    tenantId: string | null,
    now: Date = new Date(),
  ): Promise<WeeklyDigestResponseDto> {
    const latest = await this.repo.findLatestForUser(userId);
    if (latest) {
      return this.toResponse(latest.weekStarting, {
        scansCount: latest.scansCount,
        highSugarCount: latest.highSugarCount,
        recallCount: latest.recallCount,
        alternativesRecommended: latest.alternativesRecommended,
        topProducts:
          (latest.payload?.topProducts as WeeklyDigestPayload['topProducts']) ?? [],
        savings: (latest.payload?.savings as number) ?? 0,
      });
    }

    // No stored digest yet — build the previous full week on demand.
    const weekStartingUtc = this.computePreviousMondayUtc(now);
    const weekStarting = this.toDateString(weekStartingUtc);
    const payload = await this.payloadBuilder.build(userId, weekStartingUtc);

    // Persist so analytics + the next cron stay consistent (race-safe).
    await this.repo.insertIfMissing({
      userId,
      weekStarting,
      scansCount: payload.scansCount,
      highSugarCount: payload.highSugarCount,
      recallCount: payload.recallCount,
      alternativesRecommended: payload.alternativesRecommended,
      payload: payload as unknown as Record<string, unknown>,
    });

    void tenantId; // reserved: per-tenant scoping when consumers gain tenants
    return this.toResponse(weekStarting, payload);
  }

  /**
   * Map the internal digest payload to the Mobile_App contract
   * (`WeeklyDigestResponse`). Keeps the wire shape stable even as
   * the internal payload evolves.
   */
  private toResponse(
    weekStarting: string,
    payload: WeeklyDigestPayload,
  ): WeeklyDigestResponseDto {
    const start = new Date(`${weekStarting}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
    const weekEnd = this.toDateString(end);

    const highlights: string[] = [];
    if (payload.highSugarCount > 0) {
      highlights.push(
        `${payload.highSugarCount} high-sugar item${payload.highSugarCount === 1 ? '' : 's'} flagged this week.`,
      );
    }
    if (payload.recallCount > 0) {
      highlights.push(
        `${payload.recallCount} recall alert${payload.recallCount === 1 ? '' : 's'} on products you scanned.`,
      );
    }
    if (payload.alternativesRecommended > 0) {
      highlights.push(
        `${payload.alternativesRecommended} healthier alternative${payload.alternativesRecommended === 1 ? '' : 's'} suggested for you.`,
      );
    }

    return {
      weekStartDate: weekStarting,
      weekEndDate: weekEnd,
      scansCount: payload.scansCount,
      savedProductsCount: 0,
      expiringSoonCount: 0,
      recallAlertsCount: payload.recallCount,
      estimatedSavingsInr: payload.savings ?? 0,
      topCategories: (payload.topProducts ?? []).map((p) => ({
        category: p.productName,
        count: p.scans,
      })),
      healthHighlights: highlights,
    };
  }

  /**
   * Cron entrypoint. Iterates active Consumers in pages and
   * delegates each to `processConsumer`. Returns a report so the
   * cron wrapper can log and emit metrics.
   */
  async runForWeek(now: Date = new Date()): Promise<WeeklyDigestRunReport> {
    const start = Date.now();
    const weekStartingUtc = this.computePreviousMondayUtc(now);
    const weekStarting = this.toDateString(weekStartingUtc);

    const report: WeeklyDigestRunReport = {
      consumersScanned: 0,
      digestsCreated: 0,
      idempotentSkips: 0,
      optedOutSkips: 0,
      notificationsDelivered: 0,
      notificationsFailed: 0,
      durationMs: 0,
    };

    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page = await this.repo.listActiveConsumers(cursor, this.batchSize);
      if (page.length === 0) break;

      for (const consumer of page) {
        report.consumersScanned += 1;
        const outcome = await this.processConsumer(
          {
            userId: consumer.id,
            tenantId: consumer.tenantId,
            preferredLanguage: consumer.preferredLanguage,
          },
          weekStarting,
          weekStartingUtc,
        );
        switch (outcome) {
          case 'created-and-delivered':
            report.digestsCreated += 1;
            report.notificationsDelivered += 1;
            break;
          case 'created-not-delivered':
            report.digestsCreated += 1;
            report.notificationsFailed += 1;
            break;
          case 'idempotent-skip':
            report.idempotentSkips += 1;
            break;
          case 'opted-out':
            report.optedOutSkips += 1;
            break;
        }
      }

      const last = page[page.length - 1] as unknown as {
        id: string;
        createdAt: Date;
      };
      cursor = { id: last.id, createdAt: last.createdAt };
      if (page.length < this.batchSize) break;
    }

    report.durationMs = Date.now() - start;
    this.logger.info('weekly-digest.run.completed', {
      ...report,
      weekStarting,
    });
    return report;
  }

  /**
   * Process one consumer. Returns the outcome so the caller can
   * roll up counters. Visible for tests.
   */
  async processConsumer(
    consumer: ConsumerForDigest,
    weekStarting: string,
    weekStartingUtc: Date,
  ): Promise<
    | 'created-and-delivered'
    | 'created-not-delivered'
    | 'idempotent-skip'
    | 'opted-out'
  > {
    // 1. Preference gate. Honours both the `daily-insights`
    //    category opt-out and the master push-channel toggle.
    const prefs = await this.preferences.getPreferences(consumer.userId);
    const allowed = this.preferences.filterChannels(prefs, ['push'], DAILY_INSIGHTS_CATEGORY);
    if (allowed.length === 0) {
      this.logger.info('weekly-digest.skipped.preferences', {
        userId: consumer.userId,
        weekStarting,
      });
      return 'opted-out';
    }

    // 2. Idempotency fast path.
    if (await this.repo.existsForWeek(consumer.userId, weekStarting)) {
      return 'idempotent-skip';
    }

    // 3. Build payload.
    let payload: WeeklyDigestPayload;
    try {
      payload = await this.payloadBuilder.build(consumer.userId, weekStartingUtc);
    } catch (err) {
      this.logger.error('weekly-digest.payload.failed', {
        userId: consumer.userId,
        weekStarting,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      throw err;
    }

    // 4. Persist (with race-safe ON CONFLICT DO NOTHING).
    const row = await this.repo.insertIfMissing({
      userId: consumer.userId,
      weekStarting,
      scansCount: payload.scansCount,
      highSugarCount: payload.highSugarCount,
      recallCount: payload.recallCount,
      alternativesRecommended: payload.alternativesRecommended,
      payload: payload as unknown as Record<string, unknown>,
    });
    if (!row) {
      // Lost the race with a sibling scheduler. Treat as idempotent.
      return 'idempotent-skip';
    }

    void this.auditLog.logAction({
      action: 'CREATE',
      resourceType: WEEKLY_DIGEST_RESOURCE,
      resourceId: row.id,
      tenantId: consumer.tenantId ?? 'system',
      userId: consumer.userId,
      success: true,
      metadata: {
        weekStarting,
        scansCount: payload.scansCount,
        highSugarCount: payload.highSugarCount,
        recallCount: payload.recallCount,
        alternativesRecommended: payload.alternativesRecommended,
      },
    });

    // 5. Send FCM. NotificationsService re-checks preferences and
    //    enforces priority/quiet-hours rules.
    const body = this.buildNotificationBody(payload);
    try {
      await this.notifications.send({
        // The notifications service requires a tenant; consumers
        // without a personal tenant fall back to a 'system'
        // sentinel until BE-09 v2 fills it in.
        tenantId: consumer.tenantId ?? 'system',
        userId: consumer.userId,
        channels: ['push', 'in-app'],
        category: DAILY_INSIGHTS_CATEGORY,
        subject: SUBJECT,
        body,
        data: {
          digestId: row.id,
          weekStarting,
          scansCount: payload.scansCount,
          highSugarCount: payload.highSugarCount,
          recallCount: payload.recallCount,
          alternativesRecommended: payload.alternativesRecommended,
        },
        priority: 'low',
        relatedResourceType: WEEKLY_DIGEST_RESOURCE,
        relatedResourceId: row.id,
      });

      // 6. Mark delivered. We trust NotificationsService's
      //    semantics — `send` returning without throwing means the
      //    notification was at least handed off to a channel
      //    successfully (or queued for one).
      await this.repo.markDelivered(row.id, new Date());
      return 'created-and-delivered';
    } catch (err) {
      this.logger.warn('weekly-digest.notification.failed', {
        userId: consumer.userId,
        digestId: row.id,
        weekStarting,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      // Row stays with delivered_at = NULL for the redelivery
      // sweep to retry.
      return 'created-not-delivered';
    }
  }

  /**
   * Render the FCM body. Plain string — the Mobile_App is
   * expected to pull richer detail (top products, savings) from
   * the in-app inbox using the digestId in `data`.
   */
  private buildNotificationBody(payload: WeeklyDigestPayload): string {
    const parts: string[] = [];
    parts.push(
      payload.scansCount === 0
        ? 'No scans this week — '
        : `${payload.scansCount} scan${payload.scansCount === 1 ? '' : 's'} this week. `,
    );
    if (payload.highSugarCount > 0) {
      parts.push(
        `${payload.highSugarCount} high-sugar item${payload.highSugarCount === 1 ? '' : 's'} flagged. `,
      );
    }
    if (payload.recallCount > 0) {
      parts.push(
        `${payload.recallCount} recall alert${payload.recallCount === 1 ? '' : 's'}. `,
      );
    }
    if (payload.alternativesRecommended > 0) {
      parts.push(
        `${payload.alternativesRecommended} healthier alternative${payload.alternativesRecommended === 1 ? '' : 's'} suggested.`,
      );
    }
    if (parts.length === 1 && payload.scansCount > 0) {
      parts.push('Tap to see this week\u2019s summary.');
    } else if (parts.length === 1) {
      parts.push('Open RADHA to scan and stay on top of your health goals.');
    }
    return parts.join('').trim();
  }

  /**
   * Extract calendar parts in IST regardless of host timezone.
   */
  private toIstDateParts(d: Date): { year: number; month: number; day: number } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(d);
    const year = Number(parts.find((p) => p.type === 'year')?.value ?? '1970');
    const month = Number(parts.find((p) => p.type === 'month')?.value ?? '1');
    const day = Number(parts.find((p) => p.type === 'day')?.value ?? '1');
    return { year, month, day };
  }
}
