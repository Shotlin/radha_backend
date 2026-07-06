import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ExpiryModule } from '@/modules/expiry/expiry.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { NOTIFICATIONS_QUEUE_TOKEN } from '@/modules/notifications/types/notification.types';
import { ReportsModule } from '@/modules/reports/reports.module';
import { ScansModule } from '@/modules/scans/scans.module';
import { StoresModule } from '@/modules/stores/stores.module';
import { TasksModule } from '@/modules/tasks/tasks.module';
import { TenantsModule } from '@/modules/tenants/tenants.module';

import { BullMqBootstrapService } from './bullmq-queue.provider';
import { DailyAggregationCron } from './cron/daily-aggregation.cron';
import { DataRetentionCron } from './cron/data-retention.cron';
import { ExpiryStatusUpdateCron } from './cron/expiry-status-update.cron';
import { NotificationDispatchCron } from './cron/notification-dispatch.cron';
import { ScheduledReportsCron } from './cron/scheduled-reports.cron';
import { SessionCleanupCron } from './cron/session-cleanup.cron';

/**
 * BE-24 — Background jobs orchestrator.
 *
 * Lives separately from `NotificationsModule` because:
 *   1. The cron jobs span multiple modules (expiry recalc, scheduled
 *      reports, session cleanup, etc.) — owning them here keeps each
 *      feature module narrow.
 *   2. The BullMQ wiring is heavyweight (lazy-loads `bullmq` + Redis)
 *      and we only want to pay for it on the worker / scheduler
 *      processes, not on every API instance.
 *
 * Process roles:
 *   - **API** (`main.api.ts`)        → registers `JobsModule`. The
 *     bootstrap creates the queue (producer side), so HTTP calls can
 *     enqueue notifications.
 *   - **Worker** (`main.worker.ts`)  → registers `JobsModule`. The
 *     bootstrap creates queue + worker (the worker side instantiates
 *     `NotificationProcessor`).
 *   - **Scheduler** (`main.scheduler.ts`) → registers `JobsModule`.
 *     `@nestjs/schedule` decorators in this module fire here.
 *
 * Cron deduplication: `ScheduleModule.forRoot()` runs in `AppModule`,
 * so `@Cron()` decorators on these classes fire in whichever process
 * imports `JobsModule`. Production ops should set
 * `RUN_CRONS=1` only on the dedicated scheduler process and import
 * `JobsModule` from the API/worker without registering the cron
 * providers there. The fastest follow-up is to wrap each cron in a
 * `if (process.env.RUN_CRONS !== '1') return;` guard. v1 keeps the
 * decorators in place — see "BE-24 INTEGRATION CHECKLIST" for the
 * bootstrap toggle to add.
 *
 * `NOTIFICATIONS_QUEUE_TOKEN` is bound here via `useFactory` so the
 * `NotificationsService` can stay free of any BullMQ import.
 */
@Module({
  imports: [
    NotificationsModule,
    ReportsModule,
    ExpiryModule,
    TasksModule,
    ScansModule,
    StoresModule,
    TenantsModule,
  ],
  providers: [
    BullMqBootstrapService,

    /* Cron jobs */
    DailyAggregationCron,
    ExpiryStatusUpdateCron,
    SessionCleanupCron,
    DataRetentionCron,
    ScheduledReportsCron,
    NotificationDispatchCron,

    /* Bind the optional queue token to the lazy-loaded queue. */
    {
      provide: NOTIFICATIONS_QUEUE_TOKEN,
      inject: [BullMqBootstrapService],
      useFactory: async (boot: BullMqBootstrapService) => {
        return boot.initialise();
      },
    },
  ],
  exports: [BullMqBootstrapService, NOTIFICATIONS_QUEUE_TOKEN],
})
export class JobsModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly bootstrap: BullMqBootstrapService) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrap.initialise();
  }

  async onModuleDestroy(): Promise<void> {
    await this.bootstrap.shutdown();
  }
}
