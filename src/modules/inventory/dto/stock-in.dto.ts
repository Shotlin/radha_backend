import { z } from 'zod';

const STOCK_IN_REASONS = ['grn_post', 'manual_in', 'returned', 'correction'] as const;

/**
 * BE-27 — Stock-in request body.
 *
 * Captures one delivery into the store. Quantity must be a positive
 * integer (we never accept "negative stock-in" — use stock-out
 * instead). Expiry date must be after manufacture date when both are
 * supplied. Quantity capped at one million per request to keep the
 * service from being a stress-test target.
 */
export const StockInSchema = z
  .object({
    productId: z.string().uuid(),
    storeId: z.string().uuid(),
    quantity: z.coerce.number().int().positive().max(1_000_000),
    reason: z.enum(STOCK_IN_REASONS).default('manual_in'),
    batchNumber: z.string().trim().max(100).optional(),
    expiryDate: z.coerce.date().optional(),
    manufactureDate: z.coerce.date().optional(),
    unitCost: z.coerce.number().nonnegative().max(1_000_000_000).optional(),
    reference: z.string().trim().max(100).optional(),
    sourceType: z.string().trim().max(30).optional(),
    sourceId: z.string().uuid().optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((d) => !d.expiryDate || !d.manufactureDate || d.expiryDate > d.manufactureDate, {
    message: 'expiryDate must be after manufactureDate',
    path: ['expiryDate'],
  });

export type StockInDto = z.infer<typeof StockInSchema>;
