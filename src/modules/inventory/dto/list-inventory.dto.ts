import { z } from 'zod';

/**
 * BE-27 — Listing / query DTOs.
 *
 * Cursor pagination throughout. `limit` capped at 200 to bound
 * response size for the dashboard. Booleans are coerced from
 * `'true' | 'false'` strings on the query string.
 */

const csvBool = z
  .union([z.literal('true'), z.literal('false'), z.boolean()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    return v === true || v === 'true';
  });

export const ListInventoryQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  isLowStock: csvBool,
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListInventoryQueryDto = z.infer<typeof ListInventoryQuerySchema>;

const MOVEMENT_TYPES = ['in', 'out', 'adjustment', 'transfer'] as const;
const MOVEMENT_REASONS = [
  'grn_post',
  'grn_reversal',
  'manual_in',
  'sale',
  'expired',
  'damaged',
  'returned',
  'theft',
  'count_adjustment',
  'correction',
] as const;

export const ListMovementsQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  reason: z.enum(MOVEMENT_REASONS).optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListMovementsQueryDto = z.infer<typeof ListMovementsQuerySchema>;

export const InventorySummaryQuerySchema = z.object({
  storeId: z.string().uuid(),
});
export type InventorySummaryQueryDto = z.infer<typeof InventorySummaryQuerySchema>;

export const StoreScopedQuerySchema = z.object({
  storeId: z.string().uuid(),
});
export type StoreScopedQueryDto = z.infer<typeof StoreScopedQuerySchema>;
