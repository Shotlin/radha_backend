/**
 * BE-28 v2 — Razorpay integration wrapper types.
 *
 * The wrapper is the single chokepoint between the rest of the
 * RADHA backend and the Razorpay Node SDK. Services depend on
 * `IRazorpayProvider` and never touch `razorpay` directly — that
 * keeps the SDK swappable (e.g., for the deterministic mock used
 * in dev / tests) and prevents the "any" types of the SDK from
 * leaking into the service layer.
 */

export type RazorpayProviderName = 'razorpay-live' | 'razorpay-mock';

/**
 * Razorpay returns the order with `status: 'created' | 'attempted' | 'paid'`.
 * Our `razorpay_orders` row mirrors a more granular state machine
 * (created → authorised → captured → refunded → failed) — see
 * `razorpay-orders.ts`.
 */
export interface RazorpayOrderResult {
  id: string;
  amountPaise: number;
  currency: string;
  status: string;
  receipt?: string;
  notes?: Record<string, string | number | boolean>;
  createdAt: number;
  provider: RazorpayProviderName;
}

export interface CreateOrderInput {
  amountPaise: number;
  currency: 'INR';
  receipt: string;
  notes?: Record<string, string | number | boolean>;
}

export interface RazorpayPaymentVerification {
  valid: boolean;
  /**
   * The expected signature is included only on the mock provider
   * to make assertions easy in unit tests. Live verification
   * never returns the secret-derived value.
   */
  expectedSignature?: string;
}

export interface VerifyPaymentInput {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

export interface VerifyWebhookInput {
  rawBody: string;
  signature: string;
}

export interface RazorpayRefundResult {
  id: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  status: string;
  reason?: string;
  createdAt: number;
  provider: RazorpayProviderName;
}

export interface CreateRefundInput {
  paymentId: string;
  amountPaise?: number;
  reason?: string;
}

export interface IRazorpayProvider {
  readonly providerName: RazorpayProviderName;
  createOrder(input: CreateOrderInput): Promise<RazorpayOrderResult>;
  verifyPaymentSignature(input: VerifyPaymentInput): RazorpayPaymentVerification;
  verifyWebhookSignature(input: VerifyWebhookInput): boolean;
  createRefund(input: CreateRefundInput): Promise<RazorpayRefundResult>;
}

export const RAZORPAY_PROVIDER = Symbol('RAZORPAY_PROVIDER');
