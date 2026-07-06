import { z } from 'zod';

/**
 * BE-41 — Response DTO for `GET /api/v1/products/:ean/alternatives`.
 *
 * Each item is a healthier product matched in the same category as
 * the source EAN, with a partner-built affiliate link the consumer
 * can click out to.
 */
export interface HealthierAlternativeDto {
  ean: string;
  name: string;
  brand: string | null;
  healthScore: number;
  /** Partner-rendered absolute URL with affiliate id baked in. */
  affiliateLink: string;
  /** Partner used to generate the link (e.g. `amazon`, `flipkart`). */
  partnerName: string;
  /** Partner row id — passed back when logging clicks. */
  partnerId: string;
}

export const AlternativesQuerySchema = z.object({
  partner: z.string().min(1).max(50).optional(),
});

export type AlternativesQueryDto = z.infer<typeof AlternativesQuerySchema>;
