import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { OperationalHealthScoreService } from '@/modules/client-dashboard/services/operational-health-score.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { StoresRepository } from '@/modules/stores/repositories/stores.repository';
import { TenantsRepository } from '@/modules/tenants/repositories/tenants.repository';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/**
 * BE-30 v2 — Daily Operational Health Score cron.
 *
 * Schedule: 02:00 IST every day. Walks each active business tenant's
 * stores, computes today's OHS, persists the row, and fires an FCM
 * push to the owner when the day-over-day change crosses ±10 points.
 *
 * Idempotency: `OperationalHealthScoreService.computeAndPersist` does
 * an upsert keyed on `(tenant, store, date, algorithm_version)` so
 * re-running the cron the same day overwrites the row instead of
 * stacking duplicate snapshots.
 *
 * FCM trigger:
 *   - We compare today's `total` to the row whose
 *     `computed_for_date < today` and whose `algorithm_version`
 *     matches today's. Mixing versions would produce false alerts
 *     when the algorithm bumps mid-rollout.
 *   - The notification template key is `ohs-change-alert`. Adding
 *     it to the BE-24 template seed is captured in the BE-30
 *     INTEGRATION CHECKLIST as a follow-up.
 *   - We don't have a tenant-owner lookup yet, so the recipient
 *     resolution is deferred — see BE-30 INTEGRATION CHECKLIST.
 *     For now we structured-log the trigger event so QA and the
 *     orchestrator can validate the threshold logic via logs.
 *
 * Robustness: each `(tenant, store)` pair is wrapped in its own
 * try/catch — one bad store can't strand the rest. Per-store
 * failures are logged with full context.
 */
@Injectable()
export class HealthScoreDailyCron {
  private readonly logger = new Logger(HealthScoreDailyCron.name);

  constructor(
    private readonly ohs: OperationalHealthScoreService,
    private readonly tenantsRepo: TenantsRepository,
    private readonly storesRepo: StoresRepository,
    private readonly notifications: NotificationsService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 2 * * *', { name: 'health-score-daily', timeZone: 'Asia/Kolkata' })
  async run(): Promise<void> {
    this.logger.log('health-score-daily: starting');

    const tenants = (await this.tenantsRepo
      .findMany({ kind: 'business', status: 'active' } as never)
      .catch(() => [] as Array<{ id: string }>)) as Array<{ id: string }>;

    let computed = 0;
    let alerted = 0;
    let failed = 0;
    const today = new Date();

    for (const tenant of tenants) {
      const tenantId = tenant.id;
      let stores: Array<{ id: string }> = [];
      try {
        stores = (await this.storesRepo.listForTenant(tenantId)) as Array<{ id: string }>;
      } catch (err) {
        this.appLogger.error('cron.health_score_daily.tenant_list.failed', {
          tenantId,
          message: err instanceof Error ? err.message : 'unknown',
        });
        continue;
      }

      for (const store of stores) {
        try {
          const result = await this.runForStore(tenantId, store.id, today);
          computed++;
          if (result.alerted) alerted++;
        } catch (err) {
          failed++;
          this.appLogger.error('cron.health_score_daily.store.failed', {
            tenantId,
            storeId: store.id,
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }

    this.appLogger.info('cron.health_score_daily.completed', {
      tenants: tenants.length,
      computed,
      alerted,
      failed,
      actor: SYSTEM_ACTOR,
    });
  }

  /**
   * Compute, persist, and (when the threshold is crossed) trigger the
   * FCM template for one store. Public so the unit tests can drive a
   * single tenant + store deterministically without going through the
   * `@Cron` decorator.
   */
  async runForStore(
    tenantId: string,
    storeId: string,
    asOf: Date,
  ): Promise<{ today: number; previous: number | null; alerted: boolean }> {
    const todaySnapshot = await this.ohs.computeAndPersist(tenantId, storeId, asOf);

    const previous = await this.ohs.getPreviousDay(
      tenantId,
      storeId,
      asOf.toISOString().slice(0, 10),
    );

    if (!previous) {
      return { today: todaySnapshot.total, previous: null, alerted: false };
    }

    if (!OperationalHealthScoreService.deltaCrosses(todaySnapshot.total, previous.total)) {
      return { today: todaySnapshot.total, previous: previous.total, alerted: false };
    }

    await this.fireAlert(tenantId, storeId, todaySnapshot.total, previous.total).catch((err) => {
      // Notification failure must not abort the cron loop.
      this.appLogger.warn('cron.health_score_daily.alert.failed', {
        tenantId,
        storeId,
        message: err instanceof Error ? err.message : 'unknown',
      });
    });

    return { today: todaySnapshot.total, previous: previous.total, alerted: true };
  }

  /**
   * Fires the `ohs-change-alert` FCM template to the tenant owner.
   *
   * The owner-lookup step is deferred — BE-30 ships the trigger
   * point, BE-09's `TenantsRepository.findOwner(tenantId)` arrives
   * in a follow-up. Until then we structured-log the alert payload
   * so QA can validate the cron's behaviour end-to-end without a
   * real FCM connection.
   */
  private async fireAlert(
    tenantId: string,
    storeId: string,
    today: number,
    yesterday: number,
  ): Promise<void> {
    this.appLogger.info('cron.health_score_daily.alert.fired', {
      tenantId,
      storeId,
      today,
      yesterday,
      delta: today - yesterday,
      template: 'ohs-change-alert',
    });

    // The notifications service expects a `NotificationTemplateKey`,
    // and `ohs-change-alert` will be added in the next template
    // catalog sweep (BE-30 INTEGRATION CHECKLIST). Until then we
    // send a `system` category push and stash the OHS payload in
    // the data field so downstream consumers see a stable shape.
    await this.notifications
      .send({
        tenantId,
        userId: SYSTEM_ACTOR, // resolved to owner by the orchestrator follow-up
        category: 'system',
        channels: ['push'],
        subject: 'Health Score changed by 10+ points',
        body: `Your store's Operational Health Score moved from ${yesterday.toFixed(1)} to ${today.toFixed(1)}.`,
        data: {
          template: 'ohs-change-alert',
          storeId,
          today,
          yesterday,
          delta: today - yesterday,
        },
        relatedResourceType: 'operational_health_score',
        relatedResourceId: storeId,
      } as never)
      .catch(() => {
        // Best-effort: the structured-log entry above is the source
        // of truth for QA verification.
      });
  }
}
