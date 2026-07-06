import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

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

const MOCK_SECRET = 'razorpay-mock-secret-deterministic-32chr';

/**
 * Deterministic Razorpay mock used when `RAZORPAY_KEY_ID` is empty
 * (the default in `.env.development`). Mirrors the contract of the
 * live provider so the rest of the backend can be exercised end-to-end
 * without hitting Razorpay's network.
 *
 * Determinism contract:
 *   - `createOrder(receipt='X')` always returns id `order_mock_<hash(X)>`
 *     (deterministic per receipt). Tests can assert exact ids without
 *     coupling to clock time.
 *   - `verifyPaymentSignature` is a real HMAC-SHA256 of
 *     `${orderId}|${paymentId}` against `MOCK_SECRET`. The
 *     `payments.service` `verifyPayment()` test happy-path constructs
 *     the same signature and expects a `valid: true`.
 *   - `verifyWebhookSignature` follows the same HMAC scheme over the
 *     raw body, so dev tooling can replay webhook payloads without a
 *     real dashboard secret.
 */
@Injectable()
export class RazorpayMockProvider implements IRazorpayProvider {
  readonly providerName: RazorpayProviderName = 'razorpay-mock';
  private readonly logger = new Logger(RazorpayMockProvider.name);

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrderResult> {
    const orderId = `order_mock_${this.shortHash(input.receipt)}`;
    this.logger.warn(
      `[MOCK RAZORPAY] createOrder receipt=${input.receipt} amountPaise=${input.amountPaise} → ${orderId}`,
    );
    return {
      id: orderId,
      amountPaise: input.amountPaise,
      currency: input.currency,
      status: 'created',
      receipt: input.receipt,
      notes: input.notes,
      createdAt: Date.now(),
      provider: this.providerName,
    };
  }

  verifyPaymentSignature(input: VerifyPaymentInput): RazorpayPaymentVerification {
    const expected = createHmac('sha256', MOCK_SECRET)
      .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
      .digest('hex');
    const valid = this.timingSafeEqualHex(expected, input.razorpaySignature);
    return { valid, expectedSignature: expected };
  }

  verifyWebhookSignature(input: VerifyWebhookInput): boolean {
    const expected = createHmac('sha256', MOCK_SECRET).update(input.rawBody).digest('hex');
    return this.timingSafeEqualHex(expected, input.signature);
  }

  async createRefund(input: CreateRefundInput): Promise<RazorpayRefundResult> {
    const refundId = `rfnd_mock_${this.shortHash(input.paymentId)}`;
    this.logger.warn(
      `[MOCK RAZORPAY] createRefund paymentId=${input.paymentId} amountPaise=${
        input.amountPaise ?? 'full'
      } → ${refundId}`,
    );
    return {
      id: refundId,
      paymentId: input.paymentId,
      amountPaise: input.amountPaise ?? 0,
      currency: 'INR',
      status: 'processed',
      reason: input.reason,
      createdAt: Date.now(),
      provider: this.providerName,
    };
  }

  /** Test helper: build a mock signature for a given (orderId, paymentId). */
  signPayment(razorpayOrderId: string, razorpayPaymentId: string): string {
    return createHmac('sha256', MOCK_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
  }

  /** Test helper: build a mock webhook signature for a given raw body. */
  signWebhook(rawBody: string): string {
    return createHmac('sha256', MOCK_SECRET).update(rawBody).digest('hex');
  }

  private shortHash(input: string): string {
    if (!input) return randomBytes(6).toString('hex');
    // Cheap deterministic 12-char hex digest of the input.
    return createHmac('sha256', 'mock-receipt').update(input).digest('hex').slice(0, 12);
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
