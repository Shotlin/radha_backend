import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewScanSyncBatch, ScanSyncBatchRow, scanSyncBatches } from '@/db/schema/scans';

@Injectable()
export class ScanSyncBatchesRepository extends BaseRepository<
  typeof scanSyncBatches,
  ScanSyncBatchRow,
  NewScanSyncBatch,
  Partial<NewScanSyncBatch>
> {
  constructor(db: DbService) {
    super(db.getDb(), scanSyncBatches, 'scan_sync_batches');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ScanSyncBatchRow | null> {
    const [row] = await this.db
      .select()
      .from(scanSyncBatches)
      .where(and(eq(scanSyncBatches.id, id), eq(scanSyncBatches.tenantId, tenantId)))
      .limit(1);
    return (row as ScanSyncBatchRow | undefined) ?? null;
  }

  async listForTenant(
    tenantId: string,
    filters: { sessionId?: string; status?: ScanSyncBatchRow['status'] },
    limit: number,
  ): Promise<ScanSyncBatchRow[]> {
    const conditions = [eq(scanSyncBatches.tenantId, tenantId)];
    if (filters.sessionId) conditions.push(eq(scanSyncBatches.sessionId, filters.sessionId));
    if (filters.status) conditions.push(eq(scanSyncBatches.status, filters.status));
    return (await this.db
      .select()
      .from(scanSyncBatches)
      .where(and(...conditions))
      .orderBy(desc(scanSyncBatches.createdAt))
      .limit(limit)) as ScanSyncBatchRow[];
  }

  async applyDelta(
    id: string,
    delta: {
      processedItems?: number;
      succeededItems?: number;
      failedItems?: number;
      duplicateItems?: number;
    },
  ): Promise<void> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (delta.processedItems) {
      updates.processedItems = sql`${scanSyncBatches.processedItems} + ${delta.processedItems}`;
    }
    if (delta.succeededItems) {
      updates.succeededItems = sql`${scanSyncBatches.succeededItems} + ${delta.succeededItems}`;
    }
    if (delta.failedItems) {
      updates.failedItems = sql`${scanSyncBatches.failedItems} + ${delta.failedItems}`;
    }
    if (delta.duplicateItems) {
      updates.duplicateItems = sql`${scanSyncBatches.duplicateItems} + ${delta.duplicateItems}`;
    }
    if (Object.keys(updates).length === 1) return;
    await this.db
      .update(scanSyncBatches)
      .set(updates as never)
      .where(eq(scanSyncBatches.id, id));
  }
}
