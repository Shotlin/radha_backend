import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import { RazorpayLiveProvider } from './providers/razorpay-live.provider';
import { RazorpayMockProvider } from './providers/razorpay-mock.provider';
import type {
  CreateOrderInput,
  CreateRefundInput,
  IRazorpayProvider,
  RazorpayOrderResult,
  RazorpayPaymentVerification,
  RazorpayRefundResult,
  VerifyPaymentInput,
  VerifyWebhookInput,
} from './razorpay.types';

/**
 * BE-28 v2 — Public Razorpay façade.
 *
 * Mirrors the SMS pattern in `integrations/sms/sms.service.ts`: pick
 * a provider once at construction time based on
 * `config.payments.isLive` and forward all calls. Live mode hits
 * the real Razorpay SDK, mock mode returns deterministic fixtures
 * so local dev / CI stays offline.
 *
 * Architecture funnel rule: the rest of the backend imports this
 * service; nobody else touches the Razorpay SDK. That keeps the
 * SDK contained, makes signature verification a single auditable
 * surface, and lets us swap providers (Cashfree, Stripe, …) without
 * editing the service layer.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private readonly provider: IRazorpayProvider;

  constructor(
    private readonly config: ConfigService,
    private readonly mock: RazorpayMockProvider,
  ) {
    if (this.config.payments.isLive) {
      try {
        this.provider = new RazorpayLiveProvider(this.config);
        this.logger.log('Razorpay provider resolved: live');
      } catch (err) {
        // SDK not installed / construction blew up — fall back to
        // the mock so the rest of the backend still boots. The
        // first real call will surface the underlying error
        // through the exception filter.
        this.logger.error('razorpay.live.bootstrap_failed_falling_back_to_mock', {
          message: err instanceof Error ? err.message : 'unknown',
        });
        this.provider = this.mock;
      }
    } else {
      this.provider = this.mock;
      this.logger.log('Razorpay provider resolved: mock (no key configured)');
    }
  }

  get providerName(): IRazorpayProvider['providerName'] {
    return this.provider.providerName;
  }

  createOrder(input: CreateOrderInput): Promise<RazorpayOrderResult> {
    return this.provider.createOrder(input);
  }

  verifyPaymentSignature(input: VerifyPaymentInput): RazorpayPaymentVerification {
    return this.provider.verifyPaymentSignature(input);
  }

  verifyWebhookSignature(input: VerifyWebhookInput): boolean {
    return this.provider.verifyWebhookSignature(input);
  }

  createRefund(input: CreateRefundInput): Promise<RazorpayRefundResult> {
    return this.provider.createRefund(input);
  }

  /** Test helper — exposes the mock for assertion in unit tests. */
  getMockProvider(): RazorpayMockProvider {
    return this.mock;
  }
}
