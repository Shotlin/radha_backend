import { Module } from '@nestjs/common';

import { RazorpayModule } from '@/integrations/razorpay/razorpay.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

/**
 * BE-28 v2 — Payments module.
 *
 * Imports:
 *   - RazorpayModule      → SDK/mock dispatcher.
 *   - AuthModule          → guard stack + UsersRepository (for prefill).
 *   - SubscriptionsModule → promotes trial → active after capture.
 *   - ObservabilityModule → AuditLogService for every state change.
 *
 * Wired into `app.module.ts` alongside the other domain modules.
 */
@Module({
  imports: [RazorpayModule, AuthModule, SubscriptionsModule, ObservabilityModule],
  controllers: [PaymentsController],
  providers: [PaymentsRepository, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
