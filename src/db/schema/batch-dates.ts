import { sql } from 'drizzle-orm';
import {
  decimal,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-58 — Batch-aware crowd-sourced expiry (Feature B).
 *
 * Every manufactured batch of a product shares the same MFG/expiry
 * dates. `batch_date_observations` is an append-only vote log — never a
 * single mutable "truth" row — so a bad read never destroys history and
 * the consensus can always be recomputed from scratch. `product_batch_consensus`
 * is the derived, precomputed read model `consensus.ts` maintains inside
 * the same transaction as every new observation; GET endpoints only ever
 * read this table, never recompute on the fly.
 *
 * Intentionally tenant-less (like `barcode-learning`): a batch's real-world
 * expiry date is a fact about the physical product, not about which
 * tenant scanned it, so the knowledge base is shared across every user.
 */
export const batchDateObservationSourceEnum = pgEnum('batch_date_observation_source', [
  'user_scan',
  'manual',
  'backfill_scan_items',
  'backfill_expiry_records',
]);

export const productBatchConsensusStatusEnum = pgEnum('product_batch_consensus_status', [
  'candidate',
  'trusted',
  'disputed',
]);

export const batchDateObservations = pgTable(
  'batch_date_observations',
  {
    ...baseColumns,
    ean: varchar('ean', { length: 14 }).notNull(),
    /** Normalized upper-alnum — see `consensus.ts#normalizeBatchCode`. */
    batchCode: varchar('batch_code', { length: 64 }).notNull(),
    mfgDate: timestamp('mfg_date', { withTimezone: true, mode: 'date' }),
    expiryDate: timestamp('expiry_date', { withTimezone: true, mode: 'date' }).notNull(),
    userId: uuid('user_id').notNull(),
    source: batchDateObservationSourceEnum('source').notNull(),
    extractorConfidence: decimal('extractor_confidence', { precision: 3, scale: 2 }),
  },
  (t) => ({
    eanBatchIdx: index('batch_obs_ean_batch_idx').on(t.ean, t.batchCode),
    // One vote per user per (ean, batch, expiry) -- a user correcting
    // their own earlier read (different expiry) is a new vote, not a
    // duplicate; the same read replayed twice is a no-op.
    dedupeIdx: uniqueIndex('batch_obs_dedupe').on(
      t.userId,
      t.ean,
      t.batchCode,
      t.expiryDate,
    ),
  }),
);

export type BatchDateObservationRow = typeof batchDateObservations.$inferSelect;
export type NewBatchDateObservation = typeof batchDateObservations.$inferInsert;

export const productBatchConsensus = pgTable(
  'product_batch_consensus',
  {
    ean: varchar('ean', { length: 14 }).notNull(),
    batchCode: varchar('batch_code', { length: 64 }).notNull(),
    consensusExpiry: timestamp('consensus_expiry', { withTimezone: true, mode: 'date' }),
    consensusMfg: timestamp('consensus_mfg', { withTimezone: true, mode: 'date' }),
    confirmations: integer('confirmations').notNull(),
    distinctUsers: integer('distinct_users').notNull(),
    confidence: decimal('confidence', { precision: 3, scale: 2 }).notNull(),
    status: productBatchConsensusStatusEnum('status').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ean, t.batchCode] }),
  }),
);

export type ProductBatchConsensusRow = typeof productBatchConsensus.$inferSelect;
export type NewProductBatchConsensus = typeof productBatchConsensus.$inferInsert;
