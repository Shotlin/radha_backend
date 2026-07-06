import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewReport, ReportRow, reports } from '@/db/schema/reports';

import type { ListReportsFilters, ReportStatus, ReportType } from '../types/report.types';

@Injectable()
export class ReportsRepository extends BaseRepository<
  typeof reports,
  ReportRow,
  NewReport,
  Partial<NewReport>
> {
  constructor(db: DbService) {
    super(db.getDb(), reports, 'reports');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ReportRow | null> {
    const [row] = await this.db
      .select()
      .from(reports)
      .where(and(eq(reports.id, id), eq(reports.tenantId, tenantId), isNull(reports.deletedAt)))
      .limit(1);
    return (row as ReportRow | undefined) ?? null;
  }

  async listForTenant(tenantId: string, filters: ListReportsFilters): Promise<ReportRow[]> {
    const conditions = [eq(reports.tenantId, tenantId), isNull(reports.deletedAt)];
    if (filters.type) conditions.push(eq(reports.type, filters.type as ReportType));
    if (filters.status) conditions.push(eq(reports.status, filters.status as ReportStatus));
    if (filters.storeId) conditions.push(eq(reports.storeId, filters.storeId));
    if (filters.requestedBy) conditions.push(eq(reports.requestedBy, filters.requestedBy));
    if (filters.fromDate) conditions.push(gte(reports.createdAt, filters.fromDate));
    if (filters.toDate) conditions.push(lte(reports.createdAt, filters.toDate));

    return (await this.db
      .select()
      .from(reports)
      .where(and(...conditions))
      .orderBy(desc(reports.createdAt))
      .limit(filters.limit)) as ReportRow[];
  }

  /**
   * Sweep helper used by BE-24 cron — flips reports whose `expiresAt`
   * is in the past from `completed` to `expired`. Soft-deleted rows
   * are left alone.
   */
  async findExpired(now: Date, limit = 200): Promise<ReportRow[]> {
    return (await this.db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.status, 'completed'),
          lte(reports.expiresAt, now),
          isNull(reports.deletedAt),
        ),
      )
      .orderBy(asc(reports.expiresAt))
      .limit(limit)) as ReportRow[];
  }

  /**
   * Update status with optional fields in a single round-trip. Always
   * touches `updatedAt`.
   */
  async updateStatus(
    id: string,
    status: ReportStatus,
    extra: Partial<NewReport> = {},
    tx?: Transaction,
  ): Promise<void> {
    const scope = tx ?? this.db;
    await scope
      .update(reports)
      .set({ status, updatedAt: new Date(), ...extra })
      .where(eq(reports.id, id));
  }
}
