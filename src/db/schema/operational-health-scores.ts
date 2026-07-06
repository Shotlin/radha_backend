import { sql } from 'drizzle-orm';
import {
  date,
  decimal,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-30 v2 ADDENDUM — Operational Health Score history.
 *
 * One row per `(tenant, store, computed_for_date, algorithm_version)`.
 * The cron (`health-score-daily.cron.ts`) writes a fresh row every
 * morning (02:00 IST), and the Client Dashboard reads the latest row
 * for the score gauge and the last 30 rows for the sparkline trend.
 *
 * Why per-component columns instead of a single JSON blob:
 *   - the dashboard renders the breakdown with no parsing cost;
 *   - the columns are NUMERIC(5,2) so the storage is fixed and small;
 *   - drilldown queries (e.g. "show me stores whose compliance
 *     component dropped by 10 in 7 days") can use a B-tree index on
 *     a single column instead of `jsonb_path_query`.
 *
 * `raw_inputs` keeps the calculator inputs verbatim so an auditor
 * can replay the formula on a future algorithm version without
 * having to re-run the calculators against potentially mutated
 * source rows.
 */
export const operationalHealthScores = pgTable(
  'operational_health_scores',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    /** Nullable so a future tenant-level rollup can sit alongside store rows. */
    storeId: uuid('store_id'),

    computedForDate: date('computed_for_date').notNull(),
    algorithmVersion: varchar('algorithm_version', { length: 20 }).notNull(),

    totalScore: decimal('total_score', { precision: 5, scale: 2 }).notNull(),
    complianceComponent: decimal('compliance_component', { precision: 5, scale: 2 }).notNull(),
    expiryComponent: decimal('expiry_component', { precision: 5, scale: 2 }).notNull(),
    inventoryComponent: decimal('inventory_component', { precision: 5, scale: 2 }).notNull(),
    taskComponent: decimal('task_component', { precision: 5, scale: 2 }).notNull(),
    teamActivityComponent: decimal('team_activity_component', {
      precision: 5,
      scale: 2,
    }).notNull(),
    vendorQualityComponent: decimal('vendor_quality_component', {
      precision: 5,
      scale: 2,
    }).notNull(),

    rawInputs: jsonb('raw_inputs').$type<Record<string, unknown>>().notNull().default({}),

    computedAt: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /** Trend read path: latest 30 days for a store. */
    trendIdx: index('idx_ohs_trend').on(t.tenantId, t.storeId, t.computedForDate),
    /** Idempotency: re-running the cron the same day overwrites this row. */
    uniqDayAlg: uniqueIndex('uniq_ohs_tenant_store_date_alg').on(
      t.tenantId,
      t.storeId,
      t.computedForDate,
      t.algorithmVersion,
    ),
  }),
);

export type OperationalHealthScoreRow = typeof operationalHealthScores.$inferSelect;
export type NewOperationalHealthScore = typeof operationalHealthScores.$inferInsert;
