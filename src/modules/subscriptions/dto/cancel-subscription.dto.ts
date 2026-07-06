import { z } from 'zod';

/**
 * BE-28 — Cancellation DTO.
 *
 * `reason` is required (the cron uses it for retention analytics).
 * Capped at 500 chars to keep the audit log column compact.
 */
export const CancelSubscriptionSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type CancelSubscriptionDto = z.infer<typeof CancelSubscriptionSchema>;
