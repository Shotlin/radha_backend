import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import type { Transaction } from '@/db/connection';
import { NewScanSession, ScanSessionRow, scanSessions } from '@/db/schema/scans';

@Injectable()
export class ScanSessionsRepository extends BaseRepository<
  typeof scanSessions,
  ScanSessionRow,
  NewScanSession,
  Partial<NewScanSession>
> {
  constructor(db: DbService) {
    super(db.getDb(), scanSessions, 'scan_sessions');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ScanSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(scanSessions)
      .where(
        and(
          eq(scanSessions.id, id),
          eq(scanSessions.tenantId, tenantId),
          isNull(scanSessions.deletedAt),
        ),
      )
      .limit(1);
    return (row as ScanSessionRow | undefined) ?? null;
  }

  async findActiveForUser(
    userId: string,
    storeId: string,
    tenantId: string,
  ): Promise<ScanSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(scanSessions)
      .where(
        and(
          eq(scanSessions.userId, userId),
          eq(scanSessions.storeId, storeId),
          eq(scanSessions.tenantId, tenantId),
          eq(scanSessions.status, 'active'),
          isNull(scanSessions.deletedAt),
        ),
      )
      .orderBy(desc(scanSessions.startedAt))
      .limit(1);
    return (row as ScanSessionRow | undefined) ?? null;
  }

  async listForTenant(
    tenantId: string,
    filters: {
      storeId?: string;
      userId?: string;
      status?: ScanSessionRow['status'];
      type?: ScanSessionRow['type'];
    },
    limit: number,
  ): Promise<ScanSessionRow[]> {
    const conditions = [eq(scanSessions.tenantId, tenantId), isNull(scanSessions.deletedAt)];
    if (filters.storeId) conditions.push(eq(scanSessions.storeId, filters.storeId));
    if (filters.userId) conditions.push(eq(scanSessions.userId, filters.userId));
    if (filters.status) conditions.push(eq(scanSessions.status, filters.status));
    if (filters.type) conditions.push(eq(scanSessions.type, filters.type));
    return (await this.db
      .select()
      .from(scanSessions)
      .where(and(...conditions))
      .orderBy(desc(scanSessions.startedAt))
      .limit(limit)) as ScanSessionRow[];
  }

  /**
   * Atomic counter delta. The counters drift if used standalone — the
   * `ScanItemsService.recordScan` path guards this with a transaction
   * that updates counters and inserts the item together. Standalone
   * use (e.g. from a cron repair job) should follow with
   * `refreshFromItems`.
   */
  async applyCounterDeltas(
    id: string,
    delta: {
      totalScans?: number;
      uniqueProducts?: number;
      matchedEans?: number;
      unmatchedEans?: number;
      expiredItems?: number;
      nearExpiryItems?: number;
      lastActivityAt?: Date;
    },
    tx?: Transaction,
  ): Promise<void> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (delta.totalScans) {
      updates.totalScans = sql`${scanSessions.totalScans} + ${delta.totalScans}`;
    }
    if (delta.uniqueProducts) {
      updates.uniqueProducts = sql`${scanSessions.uniqueProducts} + ${delta.uniqueProducts}`;
    }
    if (delta.matchedEans) {
      updates.matchedEans = sql`${scanSessions.matchedEans} + ${delta.matchedEans}`;
    }
    if (delta.unmatchedEans) {
      updates.unmatchedEans = sql`${scanSessions.unmatchedEans} + ${delta.unmatchedEans}`;
    }
    if (delta.expiredItems) {
      updates.expiredItems = sql`${scanSessions.expiredItems} + ${delta.expiredItems}`;
    }
    if (delta.nearExpiryItems) {
      updates.nearExpiryItems = sql`${scanSessions.nearExpiryItems} + ${delta.nearExpiryItems}`;
    }
    if (delta.lastActivityAt) {
      updates.lastActivityAt = delta.lastActivityAt;
    }
    if (Object.keys(updates).length === 1) return; // only updatedAt
    const scope = tx ?? this.db;
    await scope
      .update(scanSessions)
      .set(updates as never)
      .where(eq(scanSessions.id, id));
  }

  /** Pull stale active sessions (BE-24 cron sweep). */
  async findStaleActive(inactiveThan: Date, limit = 100): Promise<ScanSessionRow[]> {
    return (await this.db
      .select()
      .from(scanSessions)
      .where(
        and(
          eq(scanSessions.status, 'active'),
          lt(scanSessions.lastActivityAt, inactiveThan),
          isNull(scanSessions.deletedAt),
        ),
      )
      .limit(limit)) as ScanSessionRow[];
  }

  async getDailyStats(
    storeId: string,
    tenantId: string,
    date: Date,
  ): Promise<{
    date: string;
    totalSessions: number;
    totalScans: number;
    byType: Record<string, number>;
  }> {
    const dayStart = new Date(date);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const rows = (await this.db
      .select({
        type: scanSessions.type,
        sessions: sql<number>`count(*)::int`,
        scans: sql<number>`coalesce(sum(${scanSessions.totalScans}), 0)::int`,
      })
      .from(scanSessions)
      .where(
        and(
          eq(scanSessions.storeId, storeId),
          eq(scanSessions.tenantId, tenantId),
          gte(scanSessions.startedAt, dayStart),
          lt(scanSessions.startedAt, dayEnd),
          isNull(scanSessions.deletedAt),
        ),
      )
      .groupBy(scanSessions.type)) as Array<{
      type: string;
      sessions: number;
      scans: number;
    }>;

    const byType: Record<string, number> = {};
    let totalSessions = 0;
    let totalScans = 0;
    for (const r of rows) {
      byType[r.type] = Number(r.sessions);
      totalSessions += Number(r.sessions);
      totalScans += Number(r.scans);
    }
    return {
      date: dayStart.toISOString().slice(0, 10),
      totalSessions,
      totalScans,
      byType,
    };
  }
}
