import { z } from 'zod';

/**
 * BE-28 v2 — Razorpay webhook payload schema.
 *
 * The webhook handler uses the Zod variant for runtime parsing
 * because Razorpay's payload shapes vary slightly between event
 * types and `class-validator` doesn't compose well with arbitrary
 * nested unions. Only the fields the handler actually reads are
 * declared — everything else passes through untouched into
 * `payment_webhooks_inbox.payload` for forensic replay.
 */

const RazorpayPaymentEntitySchema = z.object({
  id: z.string(),
  order_id: z.string().optional(),
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  status: z.string().optional(),
});

const RazorpayRefundEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number().int().nonnegative().optional(),
  status: z.string().optional(),
});

const RazorpayOrderEntitySchema = z.object({
  id: z.string(),
  amount: z.number().int().nonnegative().optional(),
  status: z.string().optional(),
});

export const RazorpayWebhookEnvelopeSchema = z.object({
  event: z.string(),
  /**
   * Razorpay's webhook envelope ships an `id` field on the top
   * level ("evt_…") that we use as the idempotency key. Some test
   * fixtures omit it, so we synthesise one in the service layer
   * when missing.
   */
  id: z.string().optional(),
  created_at: z.number().int().nonnegative().optional(),
  payload: z.object({
    payment: z
      .object({
        entity: RazorpayPaymentEntitySchema,
      })
      .optional(),
    refund: z
      .object({
        entity: RazorpayRefundEntitySchema,
      })
      .optional(),
    order: z
      .object({
        entity: RazorpayOrderEntitySchema,
      })
      .optional(),
  }),
});

export type RazorpayWebhookEnvelope = z.infer<typeof RazorpayWebhookEnvelopeSchema>;

/**
 * Supported event types — handler is conservative and ignores
 * anything outside this list (still records into the inbox so we
 * can audit later).
 */
export const SUPPORTED_RAZORPAY_EVENTS = [
  'payment.captured',
  'payment.authorized',
  'payment.failed',
  'order.paid',
  'refund.processed',
  'refund.failed',
] as const;

export type SupportedRazorpayEvent = (typeof SUPPORTED_RAZORPAY_EVENTS)[number];

export interface WebhookProcessResult {
  ok: true;
  duplicate: boolean;
  event: string;
  inboxId?: string;
}
