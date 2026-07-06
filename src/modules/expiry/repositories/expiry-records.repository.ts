import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import type { Transaction } from '@/db/connection';
import { ExpiryRecordRow, NewExpiryRecord, expiryRecords } from '@/db/schema/expiry';

import type {
  CategoryExpiryStats,
  ExpiryFilters,
  ExpiryForecast,
  ExpiryStats,
  ExpiryStatus,
} from '../types/expiry.types';

@Injectable()
export class ExpiryRecordsRepository extends BaseRepository<
  typeof expiryRecords,
  ExpiryRecordRow,
  NewExpiryRecord,
  Partial<NewExpiryRecord>
> {
  constructor(db: DbService) {
    super(db.getDb(), expiryRecords, 'expiry_records');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ExpiryRecordRow | null> {
    const [row] = await this.db
      .select()
      .from(expiryRecords)
      .where(
        and(
          eq(expiryRecords.id, id),
          eq(expiryRecords.tenantId, tenantId),
          isNull(expiryRecords.deletedAt),
        ),
      )
      .limit(1);
    return (row as ExpiryRecordRow | undefined) ?? null;
  }

  async listForStore(
    tenantId: string,
    storeId: string,
    filters: ExpiryFilters & { limit: number },
  ): Promise<ExpiryRecordRow[]> {
    const conditions = [
      eq(expiryRecords.tenantId, tenantId),
      eq(expiryRecords.storeId, storeId),
      isNull(expiryRecords.deletedAt),
    ];
    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(expiryRecords.status, filters.status));
    }
    if (filters.productId) {
      conditions.push(eq(expiryRecords.productId, filters.productId));
    }
    if (filters.fromDate) {
      conditions.push(gte(expiryRecords.expiryDate, filters.fromDate));
    }
    if (filters.toDate) {
      conditions.push(lte(expiryRecords.expiryDate, filters.toDate));
    }
    return (await this.db
      .select()
      .from(expiryRecords)
      .where(and(...conditions))
      .orderBy(asc(expiryRecords.expiryDate))
      .limit(filters.limit)) as ExpiryRecordRow[];
  }

  async findNearExpiry(
    tenantId: string,
    storeId: string,
    cutoff: Date,
  ): Promise<ExpiryRecordRow[]> {
    return (await this.db
      .select()
      .from(expiryRecords)
      .where(
        and(
          eq(expiryRecords.tenantId, tenantId),
          eq(expiryRecords.storeId, storeId),
          inArray(expiryRecords.status, ['yellow', 'red']),
          lte(expiryRecords.expiryDate, cutoff),
          isNull(expiryRecords.deletedAt),
        ),
      )
      .orderBy(asc(expiryRecords.expiryDate))) as ExpiryRecordRow[];
  }

  async findExpired(tenantId: string, storeId: string): Promise<ExpiryRecordRow[]> {
    return (await this.db
      .select()
      .from(expiryRecords)
      .where(
        and(
          eq(expiryRecords.tenantId, tenantId),
          eq(expiryRecords.storeId, storeId),
          eq(expiryRecords.status, 'expired'),
          isNull(expiryRecords.deletedAt),
        ),
      )
      .orderBy(asc(expiryRecords.expiryDate))) as ExpiryRecordRow[];
  }

  async getStoreStats(tenantId: string, storeId: string): Promise<ExpiryStats> {
    const rows = (await this.db
      .select({
        status: expiryRecords.status,
        count: sql<number>`count(*)::int`,
      })
      .from(expiryRecords)
      .where(
        and(
          eq(expiryRecords.tenantId, tenantId),
          eq(expiryRecords.storeId, storeId),
          isNull(expiryRecords.deletedAt),
        ),
      )
      .groupBy(expiryRecords.status)) as Array<{ status: ExpiryStatus; count: number }>;

    const stats: ExpiryStats = {
      storeId,
      total: 0,
      green: 0,
      yellow: 0,
      red: 0,
      expired: 0,
      unknown: 0,
    };
    for (const r of rows) {
      const n = Number(r.count);
      stats.total += n;
      stats[r.status] = n;
    }
    return stats;
  }

  async getCategoryStats(tenantId: string, storeId: string): Promise<CategoryExpiryStats[]> {
    // Joins to products via raw SQL — cross-module table reference.
    const rows = (await this.db.execute<{
      category: string;
      status: ExpiryStatus;
      count: number;
    }>(sql`
      SELECT COALESCE(p.sub_category, 'other') AS category,
             er.status,
             count(*)::int AS count
      FROM expiry_records er
      JOIN products p ON p.id = er.product_id
      WHERE er.tenant_id = ${tenantId}
        AND er.store_id = ${storeId}
        AND er.deleted_at IS NULL
      GROUP BY COALESCE(p.sub_category, 'other'), er.status
    `)) as unknown as { rows: Array<{ category: string; status: ExpiryStatus; count: number }> };

    const map = new Map<string, CategoryExpiryStats>();
    for (const row of rows.rows ?? []) {
      const cat = row.category ?? 'other';
      let bucket = map.get(cat);
      if (!bucket) {
        bucket = { category: cat, green: 0, yellow: 0, red: 0, expired: 0, unknown: 0 };
        map.set(cat, bucket);
      }
      bucket[row.status] = Number(row.count);
    }
    return [...map.values()];
  }

  async getForecast(tenantId: string, storeId: string, daysAhead: number): Promise<ExpiryForecast> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + daysAhead);

    const rows = (await this.db.execute<{
      day: string;
      expiringCount: number;
      totalQuantity: number;
    }>(sql`
      SELECT to_char(date_trunc('day', expiry_date), 'YYYY-MM-DD') AS day,
             count(*)::int AS "expiringCount",
             coalesce(sum(quantity), 0)::int AS "totalQuantity"
      FROM expiry_records
      WHERE tenant_id = ${tenantId}
        AND store_id = ${storeId}
        AND deleted_at IS NULL
        AND expiry_date >= ${start}
        AND expiry_date < ${end}
      GROUP BY day
      ORDER BY day
    `)) as unknown as {
      rows: Array<{ day: string; expiringCount: number; totalQuantity: number }>;
    };

    return {
      storeId,
      daysAhead,
      days: (rows.rows ?? []).map((r) => ({
        date: r.day,
        expiringCount: Number(r.expiringCount),
        totalQuantity: Number(r.totalQuantity),
      })),
    };
  }

  /** Walk all records for a store — used by `recalculateForStore`. */
  async streamForStore(tenantId: string, storeId: string): Promise<ExpiryRecordRow[]> {
    return (await this.db
      .select()
      .from(expiryRecords)
      .where(
        and(
          eq(expiryRecords.tenantId, tenantId),
          eq(expiryRecords.storeId, storeId),
          isNull(expiryRecords.deletedAt),
        ),
      )) as ExpiryRecordRow[];
  }

  async updateStatus(
    id: string,
    status: ExpiryStatus,
    daysRemaining: number | null,
    tx?: Transaction,
  ): Promise<void> {
    const scope = tx ?? this.db;
    await scope
      .update(expiryRecords)
      .set({
        status,
        daysRemaining,
        lastStatusUpdate: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(expiryRecords.id, id));
  }
}
