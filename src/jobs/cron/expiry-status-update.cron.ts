import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';
import { ExpiryService } from '@/modules/expiry/expiry.service';
import { StoresRepository } from '@/modules/stores/repositories/stores.repository';
import { TenantsRepository } from '@/modules/tenants/repositories/tenants.repository';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/**
 * BE-24 — Daily expiry-status recalc cron.
 *
 * Runs at 02:00 UTC. Walks every active tenant's stores and asks
 * `ExpiryService.recalculateForStore` to refresh denormalised
 * status/daysRemaining columns and create alerts where needed.
 *
 * Schedule choice: 02:00 UTC sits after the daily aggregation cron
 * (01:00) and before the data-retention sweep (Sunday 03:00).
 * Decoupled from the aggregator so a slow recalc doesn't push the
 * dashboards' data freshness off SLA.
 *
 * Robustness: each `(tenant, store)` pair is wrapped in its own
 * try/catch so one bad tenant doesn't strand the rest. Per-tenant
 * exceptions are logged and Sentry-tagged via the structured logger.
 */
@Injectable()
export class ExpiryStatusUpdateCron {
  private readonly logger = new Logger(ExpiryStatusUpdateCron.name);

  constructor(
    private readonly expiryService: ExpiryService,
    private readonly tenantsRepo: TenantsRepository,
    private readonly storesRepo: StoresRepository,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron('0 2 * * *', { name: 'expiry-status-update', timeZone: 'UTC' })
  async run(): Promise<void> {
    this.logger.log('expiry-status-update: starting');

    const tenants = await this.tenantsRepo
      .findMany({ status: 'active' } as never)
      .catch(() => [] as Array<{ id: string }>);
    let totalUpdated = 0;
    let storesProcessed = 0;
    let storesFailed = 0;

    for (const tenant of tenants as Array<{ id: string }>) {
      const tenantId = tenant.id;
      let stores: Array<{ id: string }> = [];
      try {
        stores = (await this.storesRepo.listForTenant(tenantId)) as Array<{
          id: string;
        }>;
      } catch (err) {
        this.appLogger.error('cron.expiry-status-update.tenant-list.failed', {
          tenantId,
          message: err instanceof Error ? err.message : 'unknown',
        });
        continue;
      }

      for (const store of stores) {
        try {
          const result = await this.expiryService.recalculateForStore(
            tenantId,
            SYSTEM_ACTOR,
            store.id,
          );
          totalUpdated += (result as { updated?: number }).updated ?? 0;
          storesProcessed += 1;
        } catch (err) {
          storesFailed += 1;
          this.appLogger.error('cron.expiry-status-update.store.failed', {
            tenantId,
            storeId: store.id,
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }

    this.appLogger.info('cron.expiry-status-update.completed', {
      tenants: (tenants as Array<unknown>).length,
      storesProcessed,
      storesFailed,
      totalUpdated,
    });
  }
}
