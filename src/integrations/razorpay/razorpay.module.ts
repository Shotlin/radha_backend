import { Global, Module } from '@nestjs/common';

import { RazorpayMockProvider } from './providers/razorpay-mock.provider';
import { RazorpayService } from './razorpay.service';

/**
 * BE-28 v2 — Razorpay integration module.
 *
 * Mirrors `SmsModule`: `@Global()` + ships a single public service
 * (`RazorpayService`) that decides at construction time which
 * provider is active. We register only the mock provider as a
 * Nest injectable — the live provider is constructed manually
 * inside `RazorpayService` so its `require('razorpay')` runs only
 * when keys are configured (otherwise dev environments without the
 * SDK installed would fail to boot).
 */
@Global()
@Module({
  providers: [RazorpayMockProvider, RazorpayService],
  exports: [RazorpayService, RazorpayMockProvider],
})
export class RazorpayModule {}
