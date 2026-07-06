import { z } from 'zod';

/**
 * BE-28 — DTO for system-level subscription creation.
 *
 * Public callers don't hit this — `SubscriptionsService.startTrial`
 * is invoked by the tenant-onboarding flow (BE-09) on tenant
 * creation. The DTO exists so the orchestrator's webhook surface and
 * App Owner Dashboard can initiate trials manually.
 */
export const CreateSubscriptionSchema = z.object({
  tenantId: z.string().uuid(),
  planCode: z.enum(['trial', 'starter', 'growth', 'pro']).default('trial'),
});
export type CreateSubscriptionDto = z.infer<typeof CreateSubscriptionSchema>;
