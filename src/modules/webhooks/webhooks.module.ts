import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { WebhooksController } from './controllers/webhooks.controller';
import { WebhookRetryJob } from './jobs/webhook-retry.job';
import { WebhookDeliveriesRepository } from './repositories/webhook-deliveries.repository';
import { WebhookEndpointsRepository } from './repositories/webhook-endpoints.repository';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookEmitterService } from './services/webhook-emitter.service';
import { WebhookEndpointsService } from './services/webhook-endpoints.service';
import { StubProTierPort, WEBHOOK_TIER_PORT } from './types/webhook-tier.port';

/**
 * BE-50 — Webhooks for Pro Tier.
 *
 * Wires:
 *   - `WebhooksController` for endpoint CRUD + delivery listing /
 *     replay.
 *   - `WebhookEndpointsService` (Pro tier check, 5-cap, secret gen)
 *     and `WebhookDeliveryService` (HMAC sign, POST, retry logic).
 *   - `WebhookEmitterService` for other modules to emit events into
 *     the fan-out pipeline (exported).
 *   - `WebhookRetryJob` cron — every minute, picks pending/failed
 *     deliveries and re-attempts. Harmless to import on the API
 *     process: `@Cron` decorators only fire when
 *     `ScheduleModule.forRoot()` (in AppModule) instantiates the
 *     scheduler registrar.
 *
 * `WEBHOOK_TIER_PORT` is bound to a stub today; BE-08 v2 will swap
 * in a real implementation backed by the entitlements service.
 *
 * Per the BE-50 brief, this module is intentionally NOT registered
 * in `app.module.ts`. The integration step lives in BE-50 handoff.
 */
@Module({
  imports: [AuthModule, ObservabilityModule],
  controllers: [WebhooksController],
  providers: [
    WebhookEndpointsRepository,
    WebhookDeliveriesRepository,
    WebhookEndpointsService,
    WebhookDeliveryService,
    WebhookEmitterService,
    WebhookRetryJob,
    {
      provide: WEBHOOK_TIER_PORT,
      useClass: StubProTierPort,
    },
  ],
  exports: [
    WebhookEmitterService,
    WebhookEndpointsService,
    WebhookDeliveryService,
  ],
})
export class WebhooksModule {}
