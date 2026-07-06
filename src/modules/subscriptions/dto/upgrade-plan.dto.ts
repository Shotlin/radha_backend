import { z } from 'zod';

/**
 * BE-28 — Plan upgrade / downgrade DTO.
 *
 * The same shape covers both directions; the service decides whether
 * the change is an upgrade (immediate) or a downgrade (scheduled for
 * end of period) based on the relative position of the source vs.
 * target plan in `PLAN_ORDER`.
 */
export const UpgradePlanSchema = z.object({
  planCode: z.enum(['starter', 'growth', 'pro']),
});
export type UpgradePlanDto = z.infer<typeof UpgradePlanSchema>;
