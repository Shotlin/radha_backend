import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count as drizzleCount,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { decodeCursor, encodeCursor } from '@/db/repositories/pagination.utils';
import { NewSupplier, SupplierRow, suppliers } from '@/db/schema/suppliers';

import type { PaginatedSuppliers, SupplierFilters, SupplierStatus } from '../types/supplier.types';

/**
 * BE-25 — `suppliers` table data access.
 *
 * Wraps `BaseRepository` for CRUD and adds:
 *
 *   - `findByIdInTenant`     — mandatory tenant-scoped pattern.
 *   - `findByCodeInTenant`   — used by service to detect duplicates.
 *   - `findByGstInTenant`    — used by service to detect GST clashes.
 *   - `listPaginated`        — cursor pagination on (name, id).
 *   - `search`               — flat-list search (no cursor) for the
 *                              "global" supplier picker the GRN UI uses.
 *   - `bulkCreate`           — used by the import service.
 *
 * Soft-delete is honoured everywhere; deleted rows are invisible
 * unless the caller explicitly opts in (none currently do).
 */
@Injectable()
export class SuppliersRepository extends BaseRepository<
  typeof suppliers,
  SupplierRow,
  NewSupplier,
  Partial<NewSupplier>
> {
  constructor(db: DbService) {
    super(db.getDb(), suppliers, 'suppliers');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<SupplierRow | null> {
    const [row] = await this.db
      .select()
      .from(suppliers)
      .where(
        and(eq(suppliers.id, id), eq(suppliers.tenantId, tenantId), isNull(suppliers.deletedAt)),
      )
      .limit(1);
    return (row as SupplierRow | undefined) ?? null;
  }

  /**
   * Cross-tenant lookup for the GRN supplier-verification pattern:
   * the GRN service fetches the row without a tenant filter and then
   * explicitly checks `row.tenantId === callerTenantId` so the
   * service layer owns the tenant-isolation logic rather than the DB
   * layer. Only call this from the GRN adapter — all other callers
   * must use `findByIdInTenant`.
   */
  async findById(id: string): Promise<SupplierRow | null> {
    const [row] = await this.db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, id), isNull(suppliers.deletedAt)))
      .limit(1);
    return (row as SupplierRow | undefined) ?? null;
  }

  async findByCodeInTenant(code: string, tenantId: string): Promise<SupplierRow | null> {
    const [row] = await this.db
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.tenantId, tenantId),
          eq(suppliers.code, code),
          isNull(suppliers.deletedAt),
        ),
      )
      .limit(1);
    return (row as SupplierRow | undefined) ?? null;
  }

  async findByGstInTenant(
    gst: string,
    tenantId: string,
    excludeId?: string,
  ): Promise<SupplierRow | null> {
    const conditions: SQL[] = [
      eq(suppliers.tenantId, tenantId),
      eq(suppliers.gstNumber, gst),
      isNull(suppliers.deletedAt),
    ];
    if (excludeId) conditions.push(ne(suppliers.id, excludeId));
    const [row] = await this.db
      .select()
      .from(suppliers)
      .where(and(...conditions))
      .limit(1);
    return (row as SupplierRow | undefined) ?? null;
  }

  /**
   * Cursor-paginated list for the management UI. Sort key:
   * `(name asc, id asc)` so newly-renamed suppliers don't disappear
   * between pages.
   */
  async listPaginated(filters: SupplierFilters): Promise<PaginatedSuppliers> {
    const conditions: SQL[] = this.buildFilterConditions(filters);
    const limit = filters.limit ?? 50;

    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      const lastName = decoded?.name as string | undefined;
      const lastId = decoded?.id as string | undefined;
      if (lastName !== undefined && lastId !== undefined) {
        conditions.push(sql`(${suppliers.name}, ${suppliers.id}) > (${lastName}, ${lastId})`);
      }
    }

    const rows = (await this.db
      .select()
      .from(suppliers)
      .where(and(...conditions))
      .orderBy(asc(suppliers.name), asc(suppliers.id))
      .limit(limit + 1)) as SupplierRow[];

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const nextCursor =
      hasMore && data.length > 0
        ? encodeCursor(data[data.length - 1] as unknown as Record<string, unknown>, [
            { field: 'name', direction: 'asc' },
            { field: 'id', direction: 'asc' },
          ])
        : null;

    return { data, nextCursor, hasMore };
  }

  async search(
    tenantId: string,
    query: string,
    limit = 25,
    extra: { status?: SupplierStatus[]; category?: string } = {},
  ): Promise<SupplierRow[]> {
    const conditions: SQL[] = [eq(suppliers.tenantId, tenantId), isNull(suppliers.deletedAt)];
    if (query.trim().length > 0) {
      const wildcard = `%${query.trim()}%`;
      const term = or(
        ilike(suppliers.name, wildcard),
        ilike(suppliers.code, wildcard),
        ilike(suppliers.legalName, wildcard),
        ilike(suppliers.gstNumber, wildcard),
      );
      if (term) conditions.push(term);
    }
    if (extra.status && extra.status.length > 0) {
      conditions.push(inArray(suppliers.status, extra.status));
    }
    if (extra.category) {
      conditions.push(eq(suppliers.category, extra.category));
    }
    return (await this.db
      .select()
      .from(suppliers)
      .where(and(...conditions))
      .orderBy(asc(suppliers.name))
      .limit(limit)) as SupplierRow[];
  }

  async bulkCreate(rows: NewSupplier[], tx?: Transaction): Promise<SupplierRow[]> {
    if (rows.length === 0) return [];
    const scope = tx ?? this.db;
    const inserted = (await scope
      .insert(suppliers)
      .values(rows as never[])
      .returning()) as SupplierRow[];
    return inserted;
  }

  /**
   * Atomic counter / aggregate refresh used by the performance
   * service. All numeric writes happen in one statement so concurrent
   * GRN posts don't lose updates.
   */
  async refreshPerformanceCounters(
    supplierId: string,
    deltas: {
      totalGrns?: number;
      shortShelfLifeIncidents?: number;
      totalAmountDelivered?: number;
      averageDeliveryDays?: number | null;
      qualityScore?: number | null;
      reliabilityScore?: number | null;
      lastDeliveryDate?: Date | null;
    },
    tx?: Transaction,
  ): Promise<void> {
    const scope = tx ?? this.db;
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (deltas.totalGrns !== undefined) {
      updates.totalGrns = sql`${suppliers.totalGrns} + ${deltas.totalGrns}`;
    }
    if (deltas.shortShelfLifeIncidents !== undefined) {
      updates.shortShelfLifeIncidents = sql`${suppliers.shortShelfLifeIncidents} + ${deltas.shortShelfLifeIncidents}`;
    }
    if (deltas.totalAmountDelivered !== undefined) {
      updates.totalAmountDelivered = sql`${suppliers.totalAmountDelivered} + ${deltas.totalAmountDelivered}`;
    }
    if (deltas.averageDeliveryDays !== undefined) {
      updates.averageDeliveryDays = deltas.averageDeliveryDays?.toFixed(2) ?? null;
    }
    if (deltas.qualityScore !== undefined) {
      updates.qualityScore = deltas.qualityScore;
    }
    if (deltas.reliabilityScore !== undefined) {
      updates.reliabilityScore = deltas.reliabilityScore;
    }
    if (deltas.lastDeliveryDate !== undefined) {
      updates.lastDeliveryDate = deltas.lastDeliveryDate;
    }

    if (Object.keys(updates).length === 1) return; // only updatedAt
    await scope
      .update(suppliers)
      .set(updates as never)
      .where(eq(suppliers.id, supplierId));
  }

  async countByStatus(tenantId: string): Promise<Record<SupplierStatus, number>> {
    const rows = (await this.db
      .select({ status: suppliers.status, count: drizzleCount() })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), isNull(suppliers.deletedAt)))
      .groupBy(suppliers.status)) as Array<{ status: SupplierStatus; count: number }>;
    const result: Record<SupplierStatus, number> = {
      active: 0,
      inactive: 0,
      blacklisted: 0,
      pending: 0,
    };
    for (const r of rows) result[r.status] = Number(r.count);
    return result;
  }

  async listAllForExport(tenantId: string, limit = 10_000): Promise<SupplierRow[]> {
    return (await this.db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), isNull(suppliers.deletedAt)))
      .orderBy(asc(suppliers.name), asc(suppliers.id))
      .limit(limit)) as SupplierRow[];
  }

  /* ─────────────────── helpers ─────────────────── */

  private buildFilterConditions(filters: SupplierFilters): SQL[] {
    const conditions: SQL[] = [
      eq(suppliers.tenantId, filters.tenantId),
      isNull(suppliers.deletedAt),
    ];

    if (filters.q && filters.q.trim().length > 0) {
      const wildcard = `%${filters.q.trim()}%`;
      const term = or(
        ilike(suppliers.name, wildcard),
        ilike(suppliers.code, wildcard),
        ilike(suppliers.legalName, wildcard),
        ilike(suppliers.gstNumber, wildcard),
      );
      if (term) conditions.push(term);
    }
    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(suppliers.status, filters.status));
    }
    if (filters.category) {
      conditions.push(eq(suppliers.category, filters.category));
    }
    if (filters.city) {
      conditions.push(eq(suppliers.city, filters.city));
    }
    return conditions;
  }
}
