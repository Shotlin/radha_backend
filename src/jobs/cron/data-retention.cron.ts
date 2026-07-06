import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql, type SQL } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsRepository } from '@/modules/notifications/repositories/notifications.repository';

/**
 * BE-24 — Weekly data-retention sweep.
 *
 * Runs Sunday 03:00 UTC. Deletes data older than the per-table policy:
 *
 *   - `notifications`     — read notifications older than 90 days
 *   - `audit_logs`        — older than 365 days (compliance keeps 1y)
 *   - `otp_attempts`      — older than 30 days
 *   - `user_sessions`     — expired sessions older than 7 days post-expiry
 *   - `reports`           — past their `expires_at` flipped to `expired`
 *
 * Schedule choice: Sunday + 03:00 UTC = 08:30 IST. Off-peak window
 * minimises lock contention on heavily-written tables. Weekly cadence
 * is enough for retention bookkeeping; daily would be expensive for
 * the audit table.
 *
 * Each cleanup is wrapped in its own try/catch so a slow row count on
 * one table doesn't strand the others.
 */
@Injectable()
export class DataRetentionCron {
  private readonly logger = new Logger(DataRetentionCron.name);

  constructor(
    private readonly db: DbService,
    private readonly notificationsRepo: NotificationsRepository,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 3 * * 0', { name: 'data-retention', timeZone: 'UTC' })
  async run(): Promise<void> {
    this.logger.log('data-retention: starting weekly sweep');
    const summary: Record<string, number> = {};

    summary.notifications = await this.cleanupNotifications();
    summary.otpAttempts = await this.cleanupOtpAttempts();
    summary.userSessions = await this.cleanupUserSessions();
    summary.expiredReports = await this.cleanupExpiredReports();
    summary.auditLogs = await this.cleanupAuditLogs();

    this.appLogger.info('cron.data-retention.completed', { summary });
  }

  private async cleanupNotifications(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      return await this.notificationsRepo.deleteOlderThan(cutoff, true);
    } catch (err) {
      this.appLogger.error('cron.data-retention.notifications.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return 0;
    }
  }

  private cleanupOtpAttempts(): Promise<number> {
    return this.execDelete(
      'otp_attempts',
      sql`DELETE FROM otp_attempts WHERE created_at < NOW() - INTERVAL '30 days' RETURNING request_id`,
    );
  }

  private cleanupUserSessions(): Promise<number> {
    return this.execDelete(
      'user_sessions',
      sql`DELETE FROM user_sessions WHERE expires_at < NOW() - INTERVAL '7 days' RETURNING id`,
    );
  }

  private cleanupExpiredReports(): Promise<number> {
    return this.execDelete(
      'reports',
      sql`UPDATE reports SET status = 'expired'::report_status, updated_at = NOW()
          WHERE expires_at IS NOT NULL AND expires_at < NOW()
            AND status NOT IN ('expired', 'cancelled', 'failed')
            AND deleted_at IS NULL
          RETURNING id`,
    );
  }

  private cleanupAuditLogs(): Promise<number> {
    return this.execDelete(
      'audit_logs',
      sql`DELETE FROM audit_logs WHERE occurred_at < NOW() - INTERVAL '365 days' RETURNING id`,
    );
  }

  private async execDelete(label: string, statement: SQL): Promise<number> {
    try {
      const result = await this.db.getDb().execute(statement);
      const r = result as unknown as { rowCount?: number; rows?: unknown[] };
      return r.rowCount ?? r.rows?.length ?? 0;
    } catch (err) {
      this.appLogger.error(`cron.data-retention.${label}.failed`, {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return 0;
    }
  }
}
