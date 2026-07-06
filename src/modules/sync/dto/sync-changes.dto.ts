import { z } from 'zod';

/**
 * BE-44 — Cursor-paginated `GET /sync/changes` query + response.
 *
 * The Mobile_App polls this endpoint after coming back online to pull
 * server-side changes that landed while the device was offline. The
 * cursor is opaque to the client; today it encodes the `(updatedAt,
 * id)` pair of the last row returned, but the contract is "send back
 * whatever you got".
 */

export const SyncChangesQuerySchema = z
  .object({
    /** ISO-8601 cutoff. Falls back to "now - 7d" if missing. */
    since: z.string().datetime().optional(),
    /** Opaque pagination cursor returned by a prior call. */
    cursor: z.string().min(1).max(512).optional(),
    /** Page size cap; server clamps to [1, 500]. */
    limit: z
      .union([z.number().int(), z.string().regex(/^\d+$/)])
      .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
      .pipe(z.number().int().min(1).max(500))
      .optional(),
  })
  .strict();

export type SyncChangesQueryDto = z.infer<typeof SyncChangesQuerySchema>;

/** Resource kinds that the changes endpoint surfaces. */
export type SyncChangeResource =
  | 'scan'
  | 'saved-product'
  | 'allergen-profile'
  | 'subscription'
  | 'user';

export interface SyncChange {
  resource: SyncChangeResource;
  id: string;
  updatedAt: string;
  /** Server-authored snapshot of the row, ready to merge into local DB. */
  payload: Record<string, unknown>;
  /** Soft-delete tombstone — when true, mobile should remove its row. */
  deleted?: boolean;
}

export interface SyncChangesResponseDto {
  changes: SyncChange[];
  /** Pass back as `cursor` to fetch the next page; null when caught up. */
  nextCursor: string | null;
  /** ISO timestamp of the latest server change observed in this page. */
  serverTime: string;
}
