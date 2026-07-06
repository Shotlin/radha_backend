import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import type {
  CreateOrderInput,
  CreateRefundInput,
  IRazorpayProvider,
  RazorpayOrderResult,
  RazorpayPaymentVerification,
  RazorpayProviderName,
  RazorpayRefundResult,
  VerifyPaymentInput,
  VerifyWebhookInput,
} from '../razorpay.types';

/**
 * Local typing for the subset of the Razorpay Node SDK we actually
 * call. We deliberately do NOT `import Razorpay from 'razorpay'` at
 * the top level so:
 *   1. TypeScript doesn't fail on missing `@types/razorpay` (the
 *      package ships untyped),
 *   2. the dev backend still boots when the package isn't installed
 *      (because the constructor only loads the SDK when `isLive` is
 *      true — `RazorpayService` only instantiates this provider in
 *      that case).
 */
interface RazorpayOrdersApi {
  create(opts: {
    amount: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string | number | boolean>;
  }): Promise<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    receipt?: string;
    notes?: Record<string, string | number | boolean>;
    created_at?: number;
  }>;
}

interface RazorpayPaymentsApi {
  refund(
    paymentId: string,
    opts: { amount?: number; notes?: Record<string, string> },
  ): Promise<{
    id: string;
    payment_id: string;
    amount: number;
    currency: string;
    status: string;
    notes?: Record<string, string>;
    created_at?: number;
  }>;
}

interface RazorpayClient {
  orders: RazorpayOrdersApi;
  payments: RazorpayPaymentsApi;
}

type RazorpayCtor = new (opts: { key_id: string; key_secret: string }) => RazorpayClient;

/**
 * Live Razorpay provider — wraps the official `razorpay` Node SDK.
 *
 * Constructed lazily by `RazorpayService` only when
 * `config.payments.isLive === true`, which prevents NestJS DI from
 * crashing in dev when the SDK isn't installed.
 *
 * HMAC verification (payment + webhook) uses Node's
 * `crypto.timingSafeEqual` so signature comparison is constant-time
 * and resistant to timing-side-channel attacks.
 */
@Injectable()
export class RazorpayLiveProvider implements IRazorpayProvider {
  readonly providerName: RazorpayProviderName = 'razorpay-live';
  private readonly logger = new Logger(RazorpayLiveProvider.name);
  private readonly client: RazorpayClient;
  private readonly keySecret: string;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    const { keyId, keySecret, webhookSecret } = config.payments;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;

    let RazorpayCtor: RazorpayCtor;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('razorpay') as RazorpayCtor | { default: RazorpayCtor };
      RazorpayCtor = (mod as { default?: RazorpayCtor }).default ?? (mod as RazorpayCtor);
    } catch (err) {
      // If we get here in production it's a deployment bug — the
      // SDK should be installed before live keys are set.
      this.logger.error('razorpay.sdk.load_failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw new ExternalServiceException(
        'Razorpay',
        err instanceof Error ? err : new Error('SDK not installed'),
        ErrorCode.PAYMENT_PROVIDER_ERROR,
      );
    }

    this.client = new RazorpayCtor({ key_id: keyId, key_secret: keySecret });
  }

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrderResult> {
    try {
      const order = await this.client.orders.create({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
      });
      return {
        id: order.id,
        amountPaise: order.amount,
        currency: order.currency,
        status: order.status,
        receipt: order.receipt,
        notes: order.notes,
        createdAt: order.created_at ? order.created_at * 1000 : Date.now(),
        provider: this.providerName,
      };
    } catch (err) {
      this.logger.warn('razorpay.create_order.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw new ExternalServiceException(
        'Razorpay',
        err instanceof Error ? err : new Error('createOrder failed'),
        ErrorCode.PAYMENT_PROVIDER_ERROR,
      );
    }
  }

  verifyPaymentSignature(input: VerifyPaymentInput): RazorpayPaymentVerification {
    const expected = createHmac('sha256', this.keySecret)
      .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
      .digest('hex');
    return { valid: this.timingSafeEqualHex(expected, input.razorpaySignature) };
  }

  verifyWebhookSignature(input: VerifyWebhookInput): boolean {
    if (!this.webhookSecret) return false;
    const expected = createHmac('sha256', this.webhookSecret)
      .update(input.rawBody)
      .digest('hex');
    return this.timingSafeEqualHex(expected, input.signature);
  }

  async createRefund(input: CreateRefundInput): Promise<RazorpayRefundResult> {
    try {
      const refund = await this.client.payments.refund(input.paymentId, {
        amount: input.amountPaise,
        notes: input.reason ? { reason: input.reason } : undefined,
      });
      return {
        id: refund.id,
        paymentId: refund.payment_id,
        amountPaise: refund.amount,
        currency: refund.currency,
        status: refund.status,
        reason: input.reason,
        createdAt: refund.created_at ? refund.created_at * 1000 : Date.now(),
        provider: this.providerName,
      };
    } catch (err) {
      this.logger.warn('razorpay.refund.failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw new ExternalServiceException(
        'Razorpay',
        err instanceof Error ? err : new Error('refund failed'),
        ErrorCode.PAYMENT_PROVIDER_ERROR,
      );
    }
  }

  private timingSafeEqualHex(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }
}
