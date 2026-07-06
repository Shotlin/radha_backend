import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';
import { products } from './products';

/**
 * BE-14 — search analytics & popularity tracking.
 *
 * `search_queries` records every user-initiated search (including
 * autocomplete). The data feeds:
 *   - "products users searched but we don't carry" reports (BE-25),
 *   - autocomplete ranking tweaks (popular queries surface first),
 *   - product-add prompts in the App Owner dashboard (BE-31).
 *
 * `popular_products` is a tenant-scoped popularity ledger. Updated
 * by the scan pipeline (BE-15+) and the search service. Used by the
 * `getPopular` endpoint and the `orderBy: 'popularity'` search mode.
 */

export const searchQueries = pgTable(
  'search_queries',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id'), // null for global / unauthenticated searches
    userId: uuid('user_id'),
    queryText: varchar('query_text', { length: 200 }).notNull(),
    resultCount: integer('result_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    hasResults: boolean('has_results').notNull().default(false),
    source: varchar('source', { length: 32 }).notNull().default('search'),
  },
  (t) => ({
    tenantIdx: index('search_queries_tenant_idx').on(t.tenantId, t.createdAt),
    userIdx: index('search_queries_user_idx').on(t.userId, t.createdAt),
    noResultsIdx: index('search_queries_no_results_idx').on(t.tenantId, t.createdAt),
  }),
);

export type SearchQueryRow = typeof searchQueries.$inferSelect;
export type NewSearchQuery = typeof searchQueries.$inferInsert;

export const popularProducts = pgTable(
  'popular_products',
  {
    ...baseColumns,
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id'),
    scanCount: integer('scan_count').notNull().default(0),
    searchCount: integer('search_count').notNull().default(0),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    tenantProductUniq: uniqueIndex('popular_products_tenant_product_uniq').on(
      t.tenantId,
      t.productId,
    ),
    tenantScanIdx: index('popular_products_tenant_idx').on(t.tenantId, t.scanCount),
    tenantRecencyIdx: index('popular_products_recency_idx').on(t.tenantId, t.lastSeenAt),
  }),
);

export type PopularProductRow = typeof popularProducts.$inferSelect;
export type NewPopularProduct = typeof popularProducts.$inferInsert;
