import { z } from 'zod';

/**
 * BE-27 — Stock count DTOs.
 *
 *   StartStockCountSchema    — body for starting a count session.
 *   RecordCountLineSchema    — body for one product recording.
 *   CompleteStockCountSchema — empty body, kept for pipe consistency.
 */
export const StartStockCountSchema = z.object({
  storeId: z.string().uuid(),
  startedAt: z.coerce.date().optional(),
  notes: z.string().max(1000).optional(),
});
export type StartStockCountDto = z.infer<typeof StartStockCountSchema>;

export const RecordCountLineSchema = z.object({
  productId: z.string().uuid(),
  countedQuantity: z.coerce.number().int().nonnegative().max(1_000_000_000),
  notes: z.string().max(500).optional(),
});
export type RecordCountLineDto = z.infer<typeof RecordCountLineSchema>;

export const CompleteStockCountSchema = z.object({
  notes: z.string().max(1000).optional(),
});
export type CompleteStockCountDto = z.infer<typeof CompleteStockCountSchema>;

export const CancelStockCountSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type CancelStockCountDto = z.infer<typeof CancelStockCountSchema>;
