import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { expiryReminderSent } from '@/db/schema/expiry-reminder-sent';
import { expiryRecords } from '@/db/schema/expiry';
import { products } from '@/db/schema/products';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { StoresRepository } from '@/modules/stores/repositories/stores.repository';
import { TenantsRepository } from '@/modules/tenants/repositories/tenants.repository';

/**
 * BE-B4 (Phase 10) — Expiry-reminder push-notification cron.
 *
 * Runs at 03:00 UTC, after the 02:00 status-recalc cron so
 * `days_remaining` values are fresh.
 *
 * Three reminder windows (days_remaining ∈ {7, 2, 0}):
 *   7 → "expiry-near" (7 days away)
 *   2 → "expiry-near" (2 days away)
 *   0 → "expiry-red"  (expires today)
 *
 * Dedupe: `expiry_reminder_sent (user_id, expiry_record_id, window)`
 * UNIQUE constraint makes any insert a no-op on conflict — a safe
 * re-run never double-sends.
 *
 * Robustness: each (tenant, store) pair is wrapped in its own
 * try/catch so one bad store never strands the rest.
 */
@Injectable()
export class ExpiryRemindersCron {
  private readonly logger = new Logger(ExpiryRemindersCron.name);

  constructor(
    private readonly db: DbService,
    private readonly tenantsRepo: TenantsRepository,
    private readonly storesRepo: StoresRepository,
    private readonly notifications: NotificationsService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 3 * * *', { name: 'expiry-reminders', timeZone: 'UTC' })
  async run(): Promise<void> {
    this.logger.log('expiry-reminders: starting');

    const tenants = (await this.tenantsRepo
      .findMany({ status: 'active' } as never)
      .catch(() => [])) as Array<{ id: string }>;

    let totalSent = 0;
    let totalSkipped = 0;
    let storesFailed = 0;

    for (const tenant of tenants) {
      let stores: Array<{ id: string }> = [];
      try {
        stores = (await this.storesRepo.listForTenant(tenant.id)) as Array<{ id: string }>;
      } catch (err) {
        this.appLogger.error('cron.expiry-reminders.tenant-list.failed', {
          tenantId: tenant.id,
          message: err instanceof Error ? err.message : 'unknown',
        });
        continue;
      }

      for (const store of stores) {
        try {
          const { sent, skipped } = await this._processStore(tenant.id, store.id);
          totalSent += sent;
          totalSkipped += skipped;
        } catch (err) {
          storesFailed += 1;
          this.appLogger.error('cron.expiry-reminders.store.failed', {
            tenantId: tenant.id,
            storeId: store.id,
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }

    this.appLogger.info('cron.expiry-reminders.completed', {
      tenants: tenants.length,
      totalSent,
      totalSkipped,
      storesFailed,
    });
  }

  private async _processStore(
    tenantId: string,
    storeId: string,
  ): Promise<{ sent: number; skipped: number }> {
    const drizzle = this.db.getDb();

    // Single join query: expiry records with daysRemaining in [7, 2, 0],
    // plus the product name. Only records with a known creator are eligible.
    const rows = await drizzle
      .select({
        id: expiryRecords.id,
        createdBy: expiryRecords.createdBy,
        daysRemaining: expiryRecords.daysRemaining,
        productName: products.name,
      })
      .from(expiryRecords)
      .leftJoin(products, eq(expiryRecords.productId, products.id))
      .where(
        and(
          eq(expiryRecords.tenantId, tenantId),
          eq(expiryRecords.storeId, storeId),
          inArray(expiryRecords.daysRemaining, [7, 2, 0]),
          isNull(expiryRecords.deletedAt),
          isNotNull(expiryRecords.createdBy),
        ),
      );

    let sent = 0;
    let skipped = 0;

    for (const row of rows) {
      const userId = row.createdBy!;
      const window = (row.daysRemaining ?? 0) as 7 | 2 | 0;
      const productName = row.productName ?? 'product';
      const daysRemaining = row.daysRemaining ?? 0;

      // Attempt insert into dedupe table. ON CONFLICT DO NOTHING means this
      // is a pure idempotent check-and-record in one round trip.
      const insertResult = await drizzle
        .insert(expiryReminderSent)
        .values({
          userId,
          expiryRecordId: row.id,
          window,
        })
        .onConflictDoNothing()
        .returning({ id: expiryReminderSent.id });

      // If the insert returned nothing, the row already existed → already sent.
      if (insertResult.length === 0) {
        skipped += 1;
        continue;
      }

      const template = daysRemaining === 0 ? ('expiry-red' as const) : ('expiry-near' as const);

      try {
        await this.notifications.sendTemplate(
          template,
          [{ userId }],
          { productName, daysRemaining },
          { tenantId, channels: ['push', 'in-app'] },
        );
        sent += 1;
      } catch (err) {
        // Roll back the dedupe row so a future run retries this record.
        await drizzle
          .delete(expiryReminderSent)
          .where(
            and(
              eq(expiryReminderSent.userId, userId),
              eq(expiryReminderSent.expiryRecordId, row.id),
              eq(expiryReminderSent.window, sql`${window}::smallint`),
            ),
          )
          .catch(() => {
            /* best-effort cleanup */
          });

        this.appLogger.error('cron.expiry-reminders.send.failed', {
          expiryRecordId: row.id,
          userId,
          window,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    return { sent, skipped };
  }
}
