import { Injectable } from '@nestjs/common';

import type { ScanItemRow } from '@/db/schema/scans';

import { ScanItemsRepository } from '../repositories/scan-items.repository';

/**
 * BE-17 — Idempotency lookup.
 *
 * v1 ships **DB-backed** idempotency: the unique partial index
 * `scan_items_session_client_uniq` (created in the BE-17 migration)
 * is the source of truth. The service is a thin wrapper over the
 * repository so BE-32 can later layer Redis caching on top without
 * touching consumers.
 *
 * Why no Redis in v1:
 *   - Redis isn't yet wired into the API process (BE-24+).
 *   - The DB lookup is a single indexed point-read (~1-2 ms).
 *   - The unique partial index already guarantees correctness even
 *     if the application-level check races; the duplicate INSERT
 *     fails with a 23505 unique-violation that we map to "already
 *     processed" and reuse the existing row.
 *
 * BE-32 will add a Redis L1 cache against `findByClientId` keyed on
 * `(sessionId, clientId)` with a 7-day TTL. The interface stays the
 * same.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly itemsRepo: ScanItemsRepository) {}

  /** Returns the existing scan-item if this clientId was already processed. */
  async findExisting(sessionId: string, clientId: string): Promise<ScanItemRow | null> {
    return this.itemsRepo.findByClientId(sessionId, clientId);
  }

  /** Bulk variant — returns a Map<clientId, ScanItemRow> for the items already processed. */
  async findExistingMany(
    sessionId: string,
    clientIds: string[],
  ): Promise<Map<string, ScanItemRow>> {
    if (clientIds.length === 0) return new Map();
    const rows = await this.itemsRepo.findManyByClientIds(sessionId, clientIds);
    const map = new Map<string, ScanItemRow>();
    for (const row of rows) {
      if (row.clientId) map.set(row.clientId, row);
    }
    return map;
  }
}
