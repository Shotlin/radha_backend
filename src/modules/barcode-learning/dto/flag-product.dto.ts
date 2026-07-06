import { z } from 'zod';

/**
 * BE-56 — Body of `POST /api/v1/products/:ean/flag`.
 *
 * The reason is optional — a flag with no rationale still counts
 * against the 3-strike threshold; the rationale is stored to help
 * the moderator decide on re-review.
 */
export const FlagProductSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type FlagProductDto = z.infer<typeof FlagProductSchema>;
