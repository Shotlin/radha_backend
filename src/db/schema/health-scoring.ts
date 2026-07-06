import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';
import { products } from './products';

/**
 * BE-12 Health Scoring schema.
 *
 * `product_health_assessments` is the **cache** of a deterministic
 * scoring run keyed on `(product_id, rule_version)`. The same product
 * may have one cached row per rule version (so historical assessments
 * stay traceable when v2 rules ship).
 *
 * Storage cost is small: a single JSON blob per product. Compute cost
 * of a fresh assessment is ~5 ms in pure JS — but we still cache so
 * that `GET /products/:ean/scan?mode=comprehensive` stays under the
 * 200 ms budget set by Req 4.
 *
 * IMPORTANT: this table is **not** tenant-scoped. The underlying
 * `products` row may itself be tenant-private; in that case the
 * health assessment is also effectively tenant-private because
 * nothing else can see the product. For global catalog rows (the
 * common case from BE-11) the assessment is global too — every
 * tenant gets the benefit of the same scored row.
 */
export const productHealthAssessments = pgTable(
  'product_health_assessments',
  {
    ...baseColumns,
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    overallGrade: varchar('overall_grade', { length: 1 }).notNull(), // A | B | C | D | E | U (unknown)
    overallScore: integer('overall_score').notNull(), // 0..100
    healthStatus: varchar('health_status', { length: 20 }).notNull(), // green|yellow|red|data_unavailable

    childSafetyStatus: varchar('child_safety_status', { length: 20 }).notNull(), // suitable|caution|unsuitable|unknown
    childSafetyReasons: jsonb('child_safety_reasons')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    isProcessed: varchar('is_processed', { length: 20 }).notNull(), // not|lightly|ultra|unknown

    warnings: jsonb('warnings')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    positives: jsonb('positives')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    allergens: jsonb('allergens')
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    ageBandSafety: jsonb('age_band_safety').$type<Record<string, unknown>>(),
    consumptionGuidance: jsonb('consumption_guidance').$type<Record<string, unknown>>(),

    ruleVersion: varchar('rule_version', { length: 16 }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    inputSnapshot: jsonb('input_snapshot').$type<Record<string, unknown>>(),
  },
  (t) => ({
    productIdx: index('health_product_idx').on(t.productId),
    gradeIdx: index('health_grade_idx').on(t.overallGrade),
    childSafetyIdx: index('health_child_safety_idx').on(t.childSafetyStatus),
    statusIdx: index('health_status_idx').on(t.healthStatus),
    versionIdx: index('health_version_idx').on(t.ruleVersion),
    productVersionUnique: uniqueIndex('health_product_version_unique').on(
      t.productId,
      t.ruleVersion,
    ),
  }),
);

export type ProductHealthAssessmentRow = typeof productHealthAssessments.$inferSelect;
export type NewProductHealthAssessment = typeof productHealthAssessments.$inferInsert;
