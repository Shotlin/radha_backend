import { z } from 'zod';

/**
 * BE-27 — Low-stock rule body.
 *
 * Exactly one of `productId` or `category` must be supplied. The
 * `superRefine` enforces the XOR; the storage layer's partial
 * unique indexes guard against duplicate rules within each scope.
 */
export const LowStockRuleSchema = z
  .object({
    productId: z.string().uuid().optional(),
    category: z.string().trim().min(1).max(100).optional(),
    storeId: z.string().uuid(),
    threshold: z.coerce.number().int().nonnegative().max(1_000_000_000),
    enabled: z.boolean().default(true),
    notes: z.string().max(500).optional(),
  })
  .superRefine((d, ctx) => {
    if (Boolean(d.productId) === Boolean(d.category)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of productId or category must be provided',
        path: ['productId'],
      });
    }
  });

export type LowStockRuleDto = z.infer<typeof LowStockRuleSchema>;
