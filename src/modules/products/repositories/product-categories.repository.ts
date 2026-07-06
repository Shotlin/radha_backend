import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { NewProductCategory, ProductCategoryRow, productCategories } from '@/db/schema/products';

/**
 * Repository for `product_categories`.
 *
 * Focused on the **global** category taxonomy (tenant_id = NULL) that powers
 * the consumer Top Categories rail and the catalog importer's bucketing.
 *
 * Note on idempotency: the `(tenant_id, slug)` unique index does NOT dedupe
 * global rows because Postgres treats NULLs as distinct — so {@link ensureGlobal}
 * does an explicit find-then-insert rather than `ON CONFLICT`.
 */
@Injectable()
export class ProductCategoriesRepository {
  constructor(private readonly db: DbService) {}

  async findGlobalBySlug(slug: string): Promise<ProductCategoryRow | null> {
    const [row] = await this.db
      .getDb()
      .select()
      .from(productCategories)
      .where(and(isNull(productCategories.tenantId), eq(productCategories.slug, slug)))
      .limit(1);
    return (row as ProductCategoryRow | undefined) ?? null;
  }

  async listGlobal(): Promise<ProductCategoryRow[]> {
    return (await this.db
      .getDb()
      .select()
      .from(productCategories)
      .where(isNull(productCategories.tenantId))
      .orderBy(
        asc(productCategories.sortOrder),
        asc(productCategories.name),
      )) as ProductCategoryRow[];
  }

  /** Idempotently ensure a global category exists; returns the existing or new row. */
  async ensureGlobal(input: {
    slug: string;
    name: string;
    sortOrder: number;
  }): Promise<ProductCategoryRow> {
    const existing = await this.findGlobalBySlug(input.slug);
    if (existing) return existing;
    const values: NewProductCategory = {
      tenantId: null,
      name: input.name,
      slug: input.slug,
      sortOrder: String(input.sortOrder),
    };
    const [row] = await this.db.getDb().insert(productCategories).values(values).returning();
    return row as ProductCategoryRow;
  }
}
