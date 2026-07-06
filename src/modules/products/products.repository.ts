import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewProduct, ProductRow, products } from '@/db/schema/products';

@Injectable()
export class ProductsRepository extends BaseRepository<
  typeof products,
  ProductRow,
  NewProduct,
  Partial<NewProduct>
> {
  constructor(db: DbService) {
    super(db.getDb(), products, 'products');
  }

  /**
   * Look up a product by EAN respecting tenant visibility.
   * Tenant-scoped row > global (tenant_id = NULL) > nothing.
   */
  async findVisibleByEan(ean: string, tenantId: string | null): Promise<ProductRow | null> {
    const condition = tenantId
      ? or(eq(products.tenantId, tenantId), isNull(products.tenantId))
      : isNull(products.tenantId);

    const rows = (await this.db
      .select()
      .from(products)
      .where(and(eq(products.ean, ean), condition, isNull(products.deletedAt)))) as ProductRow[];

    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0];
    return rows.find((r) => r.tenantId !== null) ?? rows[0];
  }

  async findManyByEans(eans: string[], tenantId: string | null): Promise<ProductRow[]> {
    if (eans.length === 0) return [];
    const condition = tenantId
      ? or(eq(products.tenantId, tenantId), isNull(products.tenantId))
      : isNull(products.tenantId);
    return (await this.db
      .select()
      .from(products)
      .where(
        and(inArray(products.ean, eans), condition, isNull(products.deletedAt)),
      )) as ProductRow[];
  }

  async findByIdInTenant(id: string, tenantId: string | null): Promise<ProductRow | null> {
    const condition = tenantId
      ? or(eq(products.tenantId, tenantId), isNull(products.tenantId))
      : isNull(products.tenantId);
    const [row] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.id, id), condition, isNull(products.deletedAt)))
      .limit(1);
    return (row as ProductRow | undefined) ?? null;
  }

  /**
   * Idempotent upsert of a **global catalog** product (tenant_id = NULL),
   * keyed on EAN. Used by the Open Food Facts bulk importer that seeds the
   * browse-without-scan catalog. When a global row already exists it is
   * refreshed with the latest mapped fields; otherwise a new global row is
   * created. Never touches tenant-private rows.
   */
  async upsertGlobalByEan(data: NewProduct): Promise<ProductRow> {
    const existing = await this.findVisibleByEan(data.ean, null);
    if (existing && existing.tenantId === null) {
      const [updated] = await this.db
        .update(products)
        .set({
          name: data.name,
          brand: data.brand,
          manufacturer: data.manufacturer,
          categoryId: data.categoryId,
          subCategory: data.subCategory,
          imageUrl: data.imageUrl,
          description: data.description,
          packageSize: data.packageSize,
          packageUnit: data.packageUnit,
          dataSource: data.dataSource,
          externalId: data.externalId,
          metadata: data.metadata,
          updatedAt: new Date(),
        })
        .where(eq(products.id, existing.id))
        .returning();
      return updated as ProductRow;
    }
    const [created] = await this.db
      .insert(products)
      .values({ ...data, tenantId: null })
      .returning();
    return created as ProductRow;
  }

  /**
   * Point a **global catalog** product's `image_url` at a hosted URL (e.g. the
   * CloudFront CDN URL for an uploaded curated pack-shot). Used by the Phase 3
   * image-host CLI. Matches the global row by EAN; returns null when no global
   * row exists for that EAN (the seed must run first). Never touches
   * tenant-private rows.
   */
  async updateGlobalImageByEan(ean: string, imageUrl: string): Promise<ProductRow | null> {
    const existing = await this.findVisibleByEan(ean, null);
    if (!existing || existing.tenantId !== null) return null;
    const [updated] = await this.db
      .update(products)
      .set({ imageUrl, updatedAt: new Date() })
      .where(eq(products.id, existing.id))
      .returning();
    return (updated as ProductRow | undefined) ?? null;
  }
}
