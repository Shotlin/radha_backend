import { z } from 'zod';

const STOCK_OUT_REASONS = [
  'sale',
  'expired',
  'damaged',
  'theft',
  'correction',
  'grn_reversal',
] as const;

/**
 * BE-27 — Stock-out request body.
 *
 * Quantity is a positive integer (the service flips the sign when
 * recording the movement). Optional `batchNumber` pins the deduction
 * to a single batch; without it the service uses FIFO order based on
 * earliest expiry.
 */
export const StockOutSchema = z.object({
  productId: z.string().uuid(),
  storeId: z.string().uuid(),
  quantity: z.coerce.number().int().positive().max(1_000_000),
  reason: z.enum(STOCK_OUT_REASONS).default('sale'),
  batchNumber: z.string().trim().max(100).optional(),
  sourceType: z.string().trim().max(30).optional(),
  sourceId: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
});

export type StockOutDto = z.infer<typeof StockOutSchema>;
