import { z } from 'zod';

const ADJUSTMENT_REASONS = ['count_adjustment', 'correction'] as const;

/**
 * BE-27 — Stock adjustment request body.
 *
 * Sets the new total quantity directly; the service computes the
 * signed delta and emits a single adjustment movement. `newQuantity`
 * may be 0 (removing all stock for a SKU is a legitimate adjustment)
 * but never negative.
 */
export const AdjustStockSchema = z.object({
  productId: z.string().uuid(),
  storeId: z.string().uuid(),
  newQuantity: z.coerce.number().int().nonnegative().max(1_000_000_000),
  reason: z.enum(ADJUSTMENT_REASONS).default('correction'),
  notes: z.string().max(500).optional(),
});

export type AdjustStockDto = z.infer<typeof AdjustStockSchema>;
