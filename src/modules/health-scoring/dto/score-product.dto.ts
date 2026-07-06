import { z } from 'zod';

export const HealthFiltersSchema = z.object({
  childSafe: z.coerce.boolean().optional(),
  noUltraProcessed: z.coerce.boolean().optional(),
  maxSugarPer100g: z.coerce.number().nonnegative().optional(),
  maxSodiumPer100g: z.coerce.number().nonnegative().optional(),
  excludeAllergens: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (Array.isArray(v)) return v.map((s) => s.toLowerCase());
      return v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    }),
  minGrade: z.enum(['A', 'B', 'C', 'D', 'E']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type HealthFiltersDto = z.infer<typeof HealthFiltersSchema>;

export const BulkRecomputeSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(100),
});
export type BulkRecomputeDto = z.infer<typeof BulkRecomputeSchema>;

export const ScoreScanQuerySchema = z.object({
  allergenProfileId: z.string().uuid().optional(),
  locale: z.string().min(2).max(10).optional(),
});
export type ScoreScanQueryDto = z.infer<typeof ScoreScanQuerySchema>;
