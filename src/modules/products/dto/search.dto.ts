import { z } from 'zod';

/**
 * BE-14 — search DTOs.
 *
 * The v2 ADDENDUM (Req 39) caps query length at 80 chars and the
 * top-N to 20. Free tier callers cannot override the 20 cap; paid
 * tiers can request up to 100 via the explicit `limit` field, but
 * tier enforcement happens in the controller via the BE-08
 * `PermissionsService.getEntitlements` lookup.
 */
export const SearchProductsSchema = z.object({
  q: z.string().min(1).max(80).optional(),
  ean: z
    .string()
    .regex(/^\d{8,13}$/, 'EAN must be 8–13 digits')
    .optional(),
  brand: z.string().max(100).optional(),
  category: z.string().uuid().optional(),
  healthGrade: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const arr = Array.isArray(v) ? v : v.split(',');
      const cleaned = arr
        .map((s) => s.trim().toUpperCase())
        .filter((s): s is 'A' | 'B' | 'C' | 'D' | 'E' => ['A', 'B', 'C', 'D', 'E'].includes(s));
      return cleaned.length > 0 ? cleaned : undefined;
    }),
  childSafe: z.coerce.boolean().optional(),
  excludeProcessed: z.coerce.boolean().optional(),
  status: z.enum(['active', 'discontinued', 'pending_review', 'rejected']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  orderBy: z.enum(['relevance', 'name', 'createdAt', 'popularity']).default('relevance'),
  orderDirection: z.enum(['asc', 'desc']).default('desc'),
  includeFacets: z.coerce.boolean().default(false),
});
export type SearchProductsDto = z.infer<typeof SearchProductsSchema>;

export const AutocompleteSchema = z.object({
  q: z.string().min(2).max(50),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  type: z.enum(['name', 'brand', 'all']).default('all'),
});
export type AutocompleteDto = z.infer<typeof AutocompleteSchema>;

export const PopularProductsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PopularProductsQueryDto = z.infer<typeof PopularProductsQuerySchema>;
