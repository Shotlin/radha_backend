import { z } from 'zod';

/**
 * BE-44 — Shared DTOs for bulk sync endpoints.
 *
 * Each sync request is a batch of items, where every item carries:
 *   - `idempotencyKey`: per-item dedupe key. The Mobile_App generates
 *     this when the row is first queued offline so retries on the same
 *     entity collapse into one server-side write.
 *   - `lamportTimestamp`: logical clock used for last-write-wins
 *     conflict resolution. Accepts the structured `{ counter, nodeId }`
 *     shape or a numeric/string fallback for older clients.
 *   - `payload`: the actual entity body. Schema is module-specific and
 *     deliberately validated downstream; the sync layer is transport
 *     and treats it as opaque JSON.
 *
 * The same envelope is reused for `/sync/scans`, `/sync/saved-products`
 * and `/sync/allergen-profiles` so the Mobile_App sync client has one
 * code path.
 */

const LamportTimestampSchema = z.union([
  z.object({
    counter: z.number().int().nonnegative(),
    nodeId: z.string().max(128).optional(),
  }),
  z.number().int().nonnegative(),
  z.string().min(1).max(128),
]);

export const SyncItemSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  lamportTimestamp: LamportTimestampSchema.optional(),
  clientCreatedAt: z.string().datetime().optional(),
  payload: z.record(z.unknown()),
});

export type SyncItemDto = z.infer<typeof SyncItemSchema>;

export const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(500),
});

export type SyncBatchDto = z.infer<typeof SyncBatchSchema>;

/**
 * Per-item result envelope returned to the client. Mirrors the
 * `processed` / `failed` map produced by `SyncService.processBatch`.
 */
export interface SyncProcessedItem {
  index: number;
  idempotencyKey: string;
  status: 'created' | 'updated' | 'noop' | 'conflict';
  id?: string;
}

export interface SyncFailedItem {
  index: number;
  idempotencyKey?: string;
  error: {
    code: string;
    message: string;
  };
}

export interface SyncBatchResultDto {
  processed: SyncProcessedItem[];
  failed: SyncFailedItem[];
  /** Total items received in the batch (processed + failed). */
  total: number;
}
