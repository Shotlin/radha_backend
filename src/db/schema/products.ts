import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * `tsvector` is not a built-in Drizzle type — declare it with
 * `customType` so the `searchTsv` column round-trips as a `string`
 * in TS while keeping the underlying Postgres type intact (so the
 * GIN index built in migration 0001_be14_product_search keeps
 * working). The trigger in that migration owns the value; nothing in
 * application code should write `searchTsv` directly.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * BE-10 Product Catalog.
 *
 * `tenant_id` is **nullable** — products with `tenant_id = NULL` form
 * the **global catalog** (shared across all tenants, populated from
 * Open Food Facts in BE-11 and the community learning service in
 * BE-56). Tenant-private products carry a non-null tenant_id and are
 * RLS-protected.
 *
 * Every consumer of `products` MUST handle the `tenant_id IS NULL OR tenant_id = $1`
 * pattern explicitly — this is enforced by `ProductsRepository.findVisibleByEan`
 * which is the only sanctioned read path.
 */

export const productStatusEnum = pgEnum('product_status', [
  'active',
  'discontinued',
  'pending_review',
  'rejected',
]);

export const products = pgTable(
  'products',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id'),

    ean: varchar('ean', { length: 13 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    brand: varchar('brand', { length: 100 }),
    manufacturer: varchar('manufacturer', { length: 200 }),

    categoryId: uuid('category_id'),
    subCategory: varchar('sub_category', { length: 100 }),
    productType: varchar('product_type', { length: 50 }),

    imageUrl: varchar('image_url', { length: 500 }),
    description: text('description'),

    packageSize: varchar('package_size', { length: 50 }),
    packageUnit: varchar('package_unit', { length: 20 }),
    packageType: varchar('package_type', { length: 50 }),

    status: productStatusEnum('status').notNull().default('active'),
    isVerified: boolean('is_verified').notNull().default(false),

    // Source tracking — `manual`, `open_food_facts`, `community`, etc.
    dataSource: varchar('data_source', { length: 50 }).notNull().default('manual'),
    externalId: varchar('external_id', { length: 100 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    /**
     * BE-14 — full-text search vector. **Owned by the
     * `products_search_tsv_trigger` Postgres trigger** declared in
     * migration `0001_be14_product_search.sql`. Application code
     * MUST NOT write to this column directly.
     */
    searchTsv: tsvector('search_tsv'),

    /**
     * BE-51 — Public Product Profile Pages (SEO).
     *
     * `public_slug` is a globally unique URL-friendly identifier of
     * the form `{kebab(name)}-{ean.slice(-4)}` populated by
     * `SlugService.generate()` whenever a product becomes eligible
     * for the public catalog. Nullable because tenant-private
     * products are NOT exposed publicly.
     *
     * `public_status` gates the public profile page:
     *   - `active`     — page is renderable
     *   - `withdrawn`  — the brand has pulled the product; page returns 410 Gone
     *   - `unsafe`     — the product has an active recall; page returns 410 Gone
     */
    publicSlug: text('public_slug').unique(),
    publicStatus: text('public_status').notNull().default('active'),
  },
  (t) => ({
    // Tenant-private uniqueness: same EAN can exist under multiple
    // tenants AND under tenant=NULL (global). The `WHERE` clauses
    // here mean global rows have ONE row per EAN, and each tenant has
    // at most one private row per EAN.
    eanLookup: index('products_ean_idx').on(t.ean),
    tenantEan: index('products_tenant_ean_idx').on(t.tenantId, t.ean),
    brand: index('products_brand_idx').on(t.brand),
    nameTrgm: index('products_name_idx').on(t.name),
    statusIdx: index('products_status_idx').on(t.status),
    // BE-51: indexed for slug lookup; partial index keeps it tight
    // because most rows have NULL public_slug.
    publicSlugIdx: index('idx_products_public_slug').on(t.publicSlug),
  }),
);

export type ProductRow = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export const productCategories = pgTable(
  'product_categories',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id'), // null = global category
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    parentId: uuid('parent_id'),
    sortOrder: varchar('sort_order', { length: 10 }).notNull().default('0'),
  },
  (t) => ({
    tenantNameUnique: uniqueIndex('product_categories_tenant_slug_unique').on(t.tenantId, t.slug),
    byTenant: index('product_categories_tenant_idx').on(t.tenantId),
  }),
);

export type ProductCategoryRow = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;

export const productNutrition = pgTable('product_nutrition', {
  ...baseColumns,
  productId: uuid('product_id')
    .notNull()
    .unique()
    .references(() => products.id, { onDelete: 'cascade' }),

  servingSize: decimal('serving_size', { precision: 10, scale: 2 }),
  servingUnit: varchar('serving_unit', { length: 10 }),

  calories: decimal('calories', { precision: 8, scale: 2 }),
  protein: decimal('protein', { precision: 8, scale: 2 }),
  carbohydrates: decimal('carbohydrates', { precision: 8, scale: 2 }),
  sugars: decimal('sugars', { precision: 8, scale: 2 }),
  fat: decimal('fat', { precision: 8, scale: 2 }),
  saturatedFat: decimal('saturated_fat', { precision: 8, scale: 2 }),
  transFat: decimal('trans_fat', { precision: 8, scale: 2 }),
  fiber: decimal('fiber', { precision: 8, scale: 2 }),
  sodium: decimal('sodium', { precision: 8, scale: 2 }),

  containsAllergens: jsonb('contains_allergens').$type<string[]>().default([]),
  isProcessed: varchar('is_processed', { length: 20 }),

  dataSource: varchar('data_source', { length: 50 }).notNull().default('manual'),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).default(sql`now()`),
});

export type ProductNutritionRow = typeof productNutrition.$inferSelect;
export type NewProductNutrition = typeof productNutrition.$inferInsert;
