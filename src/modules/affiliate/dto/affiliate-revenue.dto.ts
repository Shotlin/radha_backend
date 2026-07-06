import { z } from 'zod';

/**
 * BE-41 — POST /api/v1/affiliate/revenue
 *
 * Webhook payload from a partner, signed with HMAC-SHA256 using a
 * shared secret. The signature is verified in the controller against
 * the **raw** request body (not the parsed JSON) before this schema
 * is parsed — see `AffiliateController.recordRevenue`.
 *
 * Lives in its own file (separate from `affiliate-click.dto.ts`) so
 * partner-facing webhook contracts can evolve independently of the
 * mobile app's click DTO. The schema is intentionally a duplicate of
 * the legacy declaration in `affiliate-click.dto.ts`; both names
 * resolve to the same shape via `z.infer` so existing imports keep
 * working.
 */
export const AffiliateRevenueWebhookSchema = z.object({
  /** UUID of the registered partner reporting revenue. */
  partnerId: z.string().uuid(),
  /** Amount in paise (smallest currency unit). Must be positive int. */
  amountPaise: z.number().int().positive(),
  /**
   * Optional click that produced the conversion. When present, the
   * service verifies the click belongs to the same partner before
   * persisting. Bare revenue events without an attributed click are
   * accepted (some partners report aggregates only).
   */
  attributedClickId: z.string().uuid().optional(),
  /** ISO-8601 timestamp; defaults to "now" on the server. */
  reportedAt: z.string().datetime().optional(),
});

export type AffiliateRevenueWebhookDto = z.infer<typeof AffiliateRevenueWebhookSchema>;
