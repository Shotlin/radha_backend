import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import type { Transaction } from '@/db/connection';
import { NewScanItem, ScanItemRow, scanItems } from '@/db/schema/scans';

@Injectable()
export class ScanItemsRepository extends BaseRepository<
  typeof scanItems,
  ScanItemRow,
  NewScanItem,
  Partial<NewScanItem>
> {
  constructor(db: DbService) {
    super(db.getDb(), scanItems, 'scan_items');
  }

  async findBySession(
    sessionId: string,
    options: { limit?: number; ascending?: boolean } = {},
  ): Promise<ScanItemRow[]> {
    const order = options.ascending ? asc(scanItems.scannedAt) : desc(scanItems.scannedAt);
    let q = this.db
      .select()
      .from(scanItems)
      .where(and(eq(scanItems.sessionId, sessionId), isNull(scanItems.deletedAt)))
      .orderBy(order);
    if (options.limit !== undefined) {
      q = q.limit(options.limit) as typeof q;
    }
    return (await q) as ScanItemRow[];
  }

  /**
   * Duplicate detection: same EAN within the same session, optionally
   * also matching `batchNumber`. Soft-deleted items don't count as
   * duplicates.
   */
  async findDuplicate(
    sessionId: string,
    ean: string,
    batchNumber?: string,
  ): Promise<ScanItemRow | null> {
    const conditions = [
      eq(scanItems.sessionId, sessionId),
      eq(scanItems.ean, ean),
      isNull(scanItems.deletedAt),
    ];
    if (batchNumber !== undefined) {
      conditions.push(eq(scanItems.batchNumber, batchNumber));
    } else {
      conditions.push(isNull(scanItems.batchNumber));
    }
    const [row] = await this.db
      .select()
      .from(scanItems)
      .where(and(...conditions))
      .orderBy(asc(scanItems.scannedAt))
      .limit(1);
    return (row as ScanItemRow | undefined) ?? null;
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ScanItemRow | null> {
    const [row] = await this.db
      .select()
      .from(scanItems)
      .where(
        and(eq(scanItems.id, id), eq(scanItems.tenantId, tenantId), isNull(scanItems.deletedAt)),
      )
      .limit(1);
    return (row as ScanItemRow | undefined) ?? null;
  }

  /** BE-17 — idempotency lookup. NULL clientIds never collide. */
  async findByClientId(sessionId: string, clientId: string): Promise<ScanItemRow | null> {
    const [row] = await this.db
      .select()
      .from(scanItems)
      .where(
        and(
          eq(scanItems.sessionId, sessionId),
          eq(scanItems.clientId, clientId),
          isNull(scanItems.deletedAt),
        ),
      )
      .limit(1);
    return (row as ScanItemRow | undefined) ?? null;
  }

  async findManyByClientIds(sessionId: string, clientIds: string[]): Promise<ScanItemRow[]> {
    if (clientIds.length === 0) return [];
    return (await this.db
      .select()
      .from(scanItems)
      .where(
        and(
          eq(scanItems.sessionId, sessionId),
          inArray(scanItems.clientId, clientIds),
          isNull(scanItems.deletedAt),
        ),
      )) as ScanItemRow[];
  }

  async insert(row: NewScanItem, tx?: Transaction): Promise<ScanItemRow> {
    const scope = tx ?? this.db;
    const [created] = await scope.insert(scanItems).values(row).returning();
    return created as ScanItemRow;
  }

  async listForSession(sessionId: string, limit: number): Promise<ScanItemRow[]> {
    return this.findBySession(sessionId, { limit, ascending: false });
  }

  /**
   * Recompute counters from scratch for a session — used by
   * `refreshSessionStats` and the BE-24 stale-sweep repair path.
   */
  async aggregateForSession(sessionId: string): Promise<{
    totalScans: number;
    uniqueProducts: number;
    matchedEans: number;
    unmatchedEans: number;
    expiredItems: number;
    nearExpiryItems: number;
  }> {
    const [row] = (await this.db
      .select({
        totalScans: sql<number>`count(*)::int`,
        uniqueProducts: sql<number>`count(distinct ${scanItems.ean})::int`,
        matchedEans: sql<number>`sum(case when ${scanItems.eanMatchStatus} = 'matched' then 1 else 0 end)::int`,
        unmatchedEans: sql<number>`sum(case when ${scanItems.eanMatchStatus} = 'unmatched' then 1 else 0 end)::int`,
        expiredItems: sql<number>`sum(case when ${scanItems.expiryStatus} = 'red' then 1 else 0 end)::int`,
        nearExpiryItems: sql<number>`sum(case when ${scanItems.expiryStatus} = 'yellow' then 1 else 0 end)::int`,
      })
      .from(scanItems)
      .where(and(eq(scanItems.sessionId, sessionId), isNull(scanItems.deletedAt)))) as Array<{
      totalScans: number;
      uniqueProducts: number;
      matchedEans: number;
      unmatchedEans: number;
      expiredItems: number;
      nearExpiryItems: number;
    }>;
    return {
      totalScans: Number(row?.totalScans ?? 0),
      uniqueProducts: Number(row?.uniqueProducts ?? 0),
      matchedEans: Number(row?.matchedEans ?? 0),
      unmatchedEans: Number(row?.unmatchedEans ?? 0),
      expiredItems: Number(row?.expiredItems ?? 0),
      nearExpiryItems: Number(row?.nearExpiryItems ?? 0),
    };
  }
}
