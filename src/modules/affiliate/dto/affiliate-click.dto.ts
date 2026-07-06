import { z } from 'zod';

/**
 * BE-41 — POST /api/v1/affiliate/clicks
 *
 * Logs an outbound click. We deliberately do NOT capture URL
 * referrers, IP addresses, or browser fingerprints — only the EAN
 * pair, the partner, and the user id reference.
 */
export const LogAffiliateClickSchema = z.object({
  sourceProductEan: z.string().min(8).max(14),
  alternativeProductEan: z.string().min(8).max(14),
  partnerId: z.string().uuid(),
});

export type LogAffiliateClickDto = z.infer<typeof LogAffiliateClickSchema>;

/**
 * Webhook revenue contract lives in its own file (`affiliate-revenue.dto.ts`)
 * so partner-facing schemas can evolve independently. Re-exported here
 * because the tracking service was originally wired against this path
 * before BE-41 split the contracts apart.
 */
export {
  AffiliateRevenueWebhookSchema,
  type AffiliateRevenueWebhookDto,
} from './affiliate-revenue.dto';
