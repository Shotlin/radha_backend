import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * Global Open Products Facts cache (household / general merchandise).
 *
 * Mirrors `open_food_facts_cache` exactly — same TTL/negative-cache
 * strategy, deliberately not tenant-scoped (this provider's data is
 * universal, same row read by every tenant).
 */
export const openProductsFactsCache = pgTable(
  'open_products_facts_cache',
  {
    ...baseColumns,
    ean: varchar('ean', { length: 13 }).notNull().unique(),
    rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
    productName: varchar('product_name', { length: 200 }),
    brand: varchar('brand', { length: 100 }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).default(sql`now()`),
    apiVersion: varchar('api_version', { length: 10 }).notNull().default('v2'),
    fetchSuccess: boolean('fetch_success').notNull().default(true),
  },
  (t) => ({
    byEan: uniqueIndex('opf_cache_ean_unique').on(t.ean),
    byExpiry: index('opf_cache_expires_idx').on(t.expiresAt),
    byAccessed: index('opf_cache_accessed_idx').on(t.lastAccessedAt),
  }),
);

export type OpfCacheRow = typeof openProductsFactsCache.$inferSelect;
export type NewOpfCacheRow = typeof openProductsFactsCache.$inferInsert;
