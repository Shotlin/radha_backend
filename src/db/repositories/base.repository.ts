import {
  and,
  asc,
  count as drizzleCount,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  type SQL,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { DomainNotFoundException } from '@/common/errors/business.exception';

import type { DrizzleDb, Transaction } from '../connection';

import type {
  FindOptions,
  IBaseRepository,
  OrderByClause,
  PaginatedResult,
  PaginationParams,
} from './base.repository.types';
import { decodeCursor, encodeCursor } from './pagination.utils';

type AnyRow = Record<string, unknown>;

/**
 * Generic CRUD repository for a Drizzle table.
 *
 * Covers the 80% case (id-keyed tables with optional `deletedAt` and
 * `updatedAt` columns). Concrete repositories override or compose
 * methods when they need joins, sub-queries, or domain-specific
 * filters; the generic API stays intact for everything else.
 *
 * Tenant scoping (BE-09) and idempotency keys (BE-44) layer ON TOP of
 * this class. The base intentionally does not assume tenant scope —
 * a few admin/system tables are non-tenant-scoped and use this same
 * class.
 */
export abstract class BaseRepository<
  TTable extends PgTable,
  TEntity extends AnyRow,
  TInsert extends AnyRow,
  TUpdate extends AnyRow,
> implements IBaseRepository<TEntity, TInsert, TUpdate> {
  constructor(
    protected readonly db: DrizzleDb,
    protected readonly table: TTable,
    protected readonly tableName: string,
  ) {}

  protected scope(tx?: Transaction): DrizzleDb | Transaction {
    return tx ?? this.db;
  }

  protected hasSoftDelete(): boolean {
    return 'deletedAt' in (this.table as Record<string, unknown>);
  }

  protected hasUpdatedAt(): boolean {
    return 'updatedAt' in (this.table as Record<string, unknown>);
  }

  protected col(name: string): never {
    return (this.table as unknown as Record<string, never>)[name];
  }

  protected buildEqConditions(filters: Partial<TEntity>): SQL[] {
    const conditions: SQL[] = [];
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      conditions.push(eq(this.col(key), value as never));
    }
    return conditions;
  }

  protected withSoftDeleteFilter(conditions: SQL[], options?: FindOptions): SQL[] {
    if (this.hasSoftDelete() && !options?.includeSoftDeleted) {
      conditions.push(isNull(this.col('deletedAt')));
    }
    return conditions;
  }

  protected mergeUpdateTimestamp(data: TUpdate): TUpdate {
    if (!this.hasUpdatedAt()) return data;
    return { ...data, updatedAt: new Date() } as unknown as TUpdate;
  }

  /* ────────── Create ────────── */

  async create(data: TInsert, tx?: Transaction): Promise<TEntity> {
    const [row] = await this.scope(tx)
      .insert(this.table)
      .values(data as never)
      .returning();
    return row as TEntity;
  }

  async createMany(data: TInsert[], tx?: Transaction): Promise<TEntity[]> {
    if (data.length === 0) return [];
    const rows = await this.scope(tx)
      .insert(this.table)
      .values(data as never[])
      .returning();
    return rows as TEntity[];
  }

  /* ────────── Read ────────── */

  async findById(id: string, options?: FindOptions): Promise<TEntity | null> {
    const conditions = this.withSoftDeleteFilter([eq(this.col('id'), id)], options);
    const [row] = await this.db
      .select()
      .from(this.table)
      .where(and(...conditions))
      .limit(1);
    return ((row as TEntity | undefined) ?? null) as TEntity | null;
  }

  async findByIds(ids: string[], options?: FindOptions): Promise<TEntity[]> {
    if (ids.length === 0) return [];
    const conditions = this.withSoftDeleteFilter([inArray(this.col('id'), ids)], options);
    const rows = await this.db
      .select()
      .from(this.table)
      .where(and(...conditions));
    return rows as TEntity[];
  }

  async findOne(filters: Partial<TEntity>, options?: FindOptions): Promise<TEntity | null> {
    const conditions = this.withSoftDeleteFilter(this.buildEqConditions(filters), options);
    const [row] = await this.db
      .select()
      .from(this.table)
      .where(and(...conditions))
      .limit(1);
    return ((row as TEntity | undefined) ?? null) as TEntity | null;
  }

  async findMany(filters: Partial<TEntity>, options?: FindOptions): Promise<TEntity[]> {
    const conditions = this.withSoftDeleteFilter(this.buildEqConditions(filters), options);
    let q = this.db
      .select()
      .from(this.table)
      .where(and(...conditions));

    if (options?.orderBy && options.orderBy.length > 0) {
      const orderClauses = options.orderBy.map((c) =>
        c.direction === 'asc' ? asc(this.col(c.field)) : desc(this.col(c.field)),
      );
      q = q.orderBy(...orderClauses) as typeof q;
    }
    if (options?.limit !== undefined) {
      q = q.limit(options.limit) as typeof q;
    }
    if (options?.offset !== undefined) {
      q = q.offset(options.offset) as typeof q;
    }
    const rows = await q;
    return rows as TEntity[];
  }

  async findPaginated(
    filters: Partial<TEntity>,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<TEntity>> {
    const conditions = this.withSoftDeleteFilter(this.buildEqConditions(filters));

    if (pagination.cursor) {
      const cursor = decodeCursor(pagination.cursor);
      if (cursor) {
        for (const clause of pagination.orderBy) {
          const value = cursor[clause.field];
          if (value === undefined) continue;
          conditions.push(
            clause.direction === 'asc'
              ? gt(this.col(clause.field), value as never)
              : lt(this.col(clause.field), value as never),
          );
        }
      }
    }

    const orderClauses = pagination.orderBy.map((c) =>
      c.direction === 'asc' ? asc(this.col(c.field)) : desc(this.col(c.field)),
    );

    const rows = (await this.db
      .select()
      .from(this.table)
      .where(and(...conditions))
      .orderBy(...orderClauses)
      .limit(pagination.limit + 1)) as TEntity[];

    const hasMore = rows.length > pagination.limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const nextCursor =
      hasMore && data.length > 0
        ? encodeCursor(data[data.length - 1] as AnyRow, pagination.orderBy)
        : null;

    return { data, nextCursor, hasMore };
  }

  async count(filters: Partial<TEntity>): Promise<number> {
    const conditions = this.withSoftDeleteFilter(this.buildEqConditions(filters));
    const [row] = await this.db
      .select({ value: drizzleCount() })
      .from(this.table)
      .where(and(...conditions));
    return Number(row.value);
  }

  async exists(filters: Partial<TEntity>): Promise<boolean> {
    const conditions = this.withSoftDeleteFilter(this.buildEqConditions(filters));
    const [row] = await this.db
      .select({ id: this.col('id') })
      .from(this.table)
      .where(and(...conditions))
      .limit(1);
    return Boolean(row);
  }

  /* ────────── Update ────────── */

  async update(id: string, data: TUpdate, tx?: Transaction): Promise<TEntity> {
    const [row] = await this.scope(tx)
      .update(this.table)
      .set(this.mergeUpdateTimestamp(data) as never)
      .where(eq(this.col('id'), id))
      .returning();
    if (!row) throw new DomainNotFoundException(this.tableName, id);
    return row as TEntity;
  }

  async updateMany(filters: Partial<TEntity>, data: TUpdate, tx?: Transaction): Promise<number> {
    const conditions = this.withSoftDeleteFilter(this.buildEqConditions(filters));
    const result = await this.scope(tx)
      .update(this.table)
      .set(this.mergeUpdateTimestamp(data) as never)
      .where(and(...conditions))
      .returning({ id: this.col('id') });
    return (result as unknown as Array<unknown>).length;
  }

  /* ────────── Delete ────────── */

  async delete(id: string, tx?: Transaction): Promise<void> {
    if (this.hasSoftDelete()) {
      await this.softDelete(id, 'system', tx);
    } else {
      await this.hardDelete(id, tx);
    }
  }

  async softDelete(id: string, userId: string, tx?: Transaction): Promise<void> {
    if (!this.hasSoftDelete()) {
      throw new Error(`Table ${this.tableName} does not support soft delete`);
    }
    const updates: Record<string, unknown> = {
      deletedAt: new Date(),
    };
    if ('deletedBy' in (this.table as Record<string, unknown>)) {
      updates.deletedBy = userId;
    }
    if (this.hasUpdatedAt()) updates.updatedAt = new Date();

    const result = await this.scope(tx)
      .update(this.table)
      .set(updates as never)
      .where(eq(this.col('id'), id))
      .returning({ id: this.col('id') });
    if ((result as unknown as Array<unknown>).length === 0) {
      throw new DomainNotFoundException(this.tableName, id);
    }
  }

  async restore(id: string, tx?: Transaction): Promise<TEntity> {
    if (!this.hasSoftDelete()) {
      throw new Error(`Table ${this.tableName} does not support soft delete`);
    }
    const updates: Record<string, unknown> = { deletedAt: null };
    if ('deletedBy' in (this.table as Record<string, unknown>)) updates.deletedBy = null;
    if (this.hasUpdatedAt()) updates.updatedAt = new Date();

    const [row] = await this.scope(tx)
      .update(this.table)
      .set(updates as never)
      .where(eq(this.col('id'), id))
      .returning();
    if (!row) throw new DomainNotFoundException(this.tableName, id);
    return row as TEntity;
  }

  async hardDelete(id: string, tx?: Transaction): Promise<void> {
    const result = await this.scope(tx)
      .delete(this.table)
      .where(eq(this.col('id'), id))
      .returning({ id: this.col('id') });
    if ((result as unknown as Array<unknown>).length === 0) {
      throw new DomainNotFoundException(this.tableName, id);
    }
  }

  /* ────────── Helpers exposed for subclasses ────────── */

  static buildOrderClauses<T extends PgTable>(table: T, orderBy: OrderByClause[]): SQL[] {
    const tableCols = table as unknown as Record<string, never>;
    return orderBy.map((c) =>
      c.direction === 'asc' ? asc(tableCols[c.field]) : desc(tableCols[c.field]),
    );
  }
}
