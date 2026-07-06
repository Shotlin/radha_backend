import { Injectable } from '@nestjs/common';

import type { ScanItemRow } from '@/db/schema/scans';

import { ScanItemsRepository } from '../repositories/scan-items.repository';

/**
 * BE-16 — Within-session duplicate detection.
 *
 * Policy:
 *   - Same EAN + same `batchNumber`  → duplicate.
 *   - Same EAN + both batchNumber NULL → duplicate.
 *   - Same EAN + different batchNumbers → NOT a duplicate (legitimate
 *     re-scan of a different lot).
 *
 * Soft-deleted items are excluded — removing a duplicate flags the
 * NEXT scan of the same EAN as the new "first occurrence".
 */
@Injectable()
export class DuplicateDetectorService {
  constructor(private readonly itemsRepo: ScanItemsRepository) {}

  async findDuplicate(
    sessionId: string,
    ean: string,
    batchNumber?: string | null,
  ): Promise<ScanItemRow | null> {
    return this.itemsRepo.findDuplicate(sessionId, ean, batchNumber ?? undefined);
  }
}
