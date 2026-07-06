import type { Transaction } from '../connection';

export interface OrderByClause {
  field: string;
  direction: 'asc' | 'desc';
  nullsFirst?: boolean;
}

export interface FindOptions {
  includeSoftDeleted?: boolean;
  select?: string[];
  orderBy?: OrderByClause[];
  limit?: number;
  offset?: number;
}

export interface PaginationParams {
  cursor?: string;
  limit: number;
  orderBy: OrderByClause[];
}

export interface PaginatedResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export interface IBaseRepository<TEntity, TInsert, TUpdate> {
  create(data: TInsert, tx?: Transaction): Promise<TEntity>;
  createMany(data: TInsert[], tx?: Transaction): Promise<TEntity[]>;
  findById(id: string, options?: FindOptions): Promise<TEntity | null>;
  findByIds(ids: string[], options?: FindOptions): Promise<TEntity[]>;
  findOne(filters: Partial<TEntity>, options?: FindOptions): Promise<TEntity | null>;
  findMany(filters: Partial<TEntity>, options?: FindOptions): Promise<TEntity[]>;
  findPaginated(
    filters: Partial<TEntity>,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<TEntity>>;
  count(filters: Partial<TEntity>): Promise<number>;
  exists(filters: Partial<TEntity>): Promise<boolean>;
  update(id: string, data: TUpdate, tx?: Transaction): Promise<TEntity>;
  updateMany(filters: Partial<TEntity>, data: TUpdate, tx?: Transaction): Promise<number>;
  delete(id: string, tx?: Transaction): Promise<void>;
  softDelete(id: string, userId: string, tx?: Transaction): Promise<void>;
  restore(id: string, tx?: Transaction): Promise<TEntity>;
  hardDelete(id: string, tx?: Transaction): Promise<void>;
}
