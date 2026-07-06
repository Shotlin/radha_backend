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
 * Global Open Food Facts cache.
 *
 * Deliberately *not* tenant-scoped — OFF data is universal.
 * The same row is read by every tenant. `fetch_success = false` rows
 * are negative caches (OFF returned 404 / "product not found"); we
 * keep them so we don't slam OFF for the same missing EAN every time
 * a Mobile_App scans the unknown barcode.
 */
export const openFoodFactsCache = pgTable(
  'open_food_facts_cache',
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
    byEan: uniqueIndex('off_cache_ean_unique').on(t.ean),
    byExpiry: index('off_cache_expires_idx').on(t.expiresAt),
    byAccessed: index('off_cache_accessed_idx').on(t.lastAccessedAt),
  }),
);

export type OffCacheRow = typeof openFoodFactsCache.$inferSelect;
export type NewOffCacheRow = typeof openFoodFactsCache.$inferInsert;
