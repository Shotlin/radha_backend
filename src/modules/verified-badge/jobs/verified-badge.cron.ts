import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import { PRO_TIER_PORT, type IProTierPort } from '../ports/pro-tier.port';
import { VerifiedBadgeService, type BadgeVerdict } from '../services/verified-badge.service';
/**
 * BE-52 — daily verified-badge evaluation.
 *
 * Schedule: `0 3 * * *` IST. Runs at 03:00 Asia/Kolkata, *after* the
 * BE-30 OHS cron (02:00 IST) finishes writing the day's score so we
 * always evaluate against the freshest 30-day window.
 *
 * Failure model:
 *   - Per-tenant errors are caught and reported individually so a
 *     bad tenant doesn't block the rest of the sweep.
 *   - An unhandled error escaping `runDailyEvaluation()` is logged
 *     to Sentry so the on-call sees a single well-shaped alert.
 *
 * Idempotency is provided by the underlying service:
 *   `evaluateTenant()` either upserts the badge row or updates the
 *   existing row in place. Re-running the cron the same day is
 *   safe; the audit log will only show the first transition.
 */
@Injectable()
export class VerifiedBadgeCron {
  private readonly logger = new Logger(VerifiedBadgeCron.name);

  constructor(
    private readonly badgeService: VerifiedBadgeService,
    private readonly appLogger: LoggerService,
    @Inject(PRO_TIER_PORT)
    private readonly proTier: IProTierPort,
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking: IErrorTrackingService,
  ) {}

  @Cron('0 3 * * *', {
    name: 'verified-badge-daily',
    timeZone: 'Asia/Kolkata',
  })
  async runDailyEvaluation(): Promise<{
    evaluated: number;
    issued: number;
    revoked: number;
    reissued: number;
    unchanged: number;
    skipped: number;
    failed: number;
  }> {
    this.appLogger.info('cron.verified-badge.started');
    const summary = {
      evaluated: 0,
      issued: 0,
      revoked: 0,
      reissued: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };

    let tenantIds: string[];
    try {
      tenantIds = await this.proTier.listProTenantIds();
    } catch (err) {
      this.logger.error('cron.verified-badge.list-tenants.failed', err as Error);
      this.errorTracking.captureException(err as Error, {
        module: 'verified-badge',
        metadata: { phase: 'list-pro-tenants' },
      });
      return summary;
    }

    for (const tenantId of tenantIds) {
      summary.evaluated += 1;
      try {
        const verdict = await this.badgeService.evaluateTenant(tenantId);
        this.tally(summary, verdict);
      } catch (err) {
        summary.failed += 1;
        this.logger.error('cron.verified-badge.tenant.failed', err as Error);
        this.appLogger.error('cron.verified-badge.tenant.failed', {
          tenantId,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
        // Per-tenant error → Sentry warn (we don't escalate to error
        // unless the entire sweep blows up).
        this.errorTracking.captureException(err as Error, {
          module: 'verified-badge',
          metadata: { tenantId, phase: 'evaluate-tenant' },
        });
      }
    }

    this.appLogger.info('cron.verified-badge.completed', summary);
    return summary;
  }

  private tally(summary: { [k: string]: number }, verdict: BadgeVerdict): void {
    switch (verdict.outcome) {
      case 'issued':
        summary.issued += 1;
        break;
      case 'revoked':
        summary.revoked += 1;
        break;
      case 'reissued':
        summary.reissued += 1;
        break;
      case 'unchanged':
        summary.unchanged += 1;
        break;
      case 'skipped-non-pro':
        summary.skipped += 1;
        break;
    }
  }
}
