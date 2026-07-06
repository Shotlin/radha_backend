import {
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-29 — Pre-aggregated owner KPIs (one row per UTC day).
 *
 * `OwnerMetricsAggregatorService` upserts rows here on `(date)` so a
 * cron re-run for the same day is idempotent.
 *
 * Read by:
 *   - BE-30 mobile client dashboard.
 *   - BE-31 owner web dashboard.
 */

export const ownerDailyMetrics = pgTable(
  'owner_daily_metrics',
  {
    ...baseColumns,
    /** UTC midnight of the day being aggregated. */
    date: timestamp('date', { withTimezone: true }).notNull(),

    // Website ────────────────────────────────────────────────
    websiteVisitors: integer('website_visitors').notNull().default(0),
    websitePageViews: integer('website_page_views').notNull().default(0),
    websiteContactClicks: integer('website_contact_clicks').notNull().default(0),
    websitePricingViews: integer('website_pricing_views').notNull().default(0),
    websiteAppDownloadClicks: integer('website_app_download_clicks').notNull().default(0),

    // Leads ──────────────────────────────────────────────────
    newLeads: integer('new_leads').notNull().default(0),
    qualifiedLeads: integer('qualified_leads').notNull().default(0),
    convertedLeads: integer('converted_leads').notNull().default(0),

    // Tenants ────────────────────────────────────────────────
    newTenants: integer('new_tenants').notNull().default(0),
    activeTenants: integer('active_tenants').notNull().default(0),
    trialTenants: integer('trial_tenants').notNull().default(0),
    paidTenants: integer('paid_tenants').notNull().default(0),
    cancelledTenants: integer('cancelled_tenants').notNull().default(0),

    // Plan distribution snapshot ─────────────────────────────
    starterCount: integer('starter_count').notNull().default(0),
    growthCount: integer('growth_count').notNull().default(0),
    proCount: integer('pro_count').notNull().default(0),

    // Revenue (paise stored as decimal for precision) ────────
    mrr: decimal('mrr', { precision: 14, scale: 2 }).notNull().default('0'),
    newMrr: decimal('new_mrr', { precision: 14, scale: 2 }).notNull().default('0'),
    churnedMrr: decimal('churned_mrr', { precision: 14, scale: 2 }).notNull().default('0'),

    // Usage ──────────────────────────────────────────────────
    totalScans: integer('total_scans').notNull().default(0),
    totalReports: integer('total_reports').notNull().default(0),
    totalAiCalls: integer('total_ai_calls').notNull().default(0),
    totalEanValidations: integer('total_ean_validations').notNull().default(0),

    // Active users ───────────────────────────────────────────
    dau: integer('dau').notNull().default(0),
    mau: integer('mau').notNull().default(0),

    // Costs ──────────────────────────────────────────────────
    aiCost: decimal('ai_cost', { precision: 12, scale: 6 }).notNull().default('0'),
    smsCost: decimal('sms_cost', { precision: 12, scale: 6 }).notNull().default('0'),
    s3Cost: decimal('s3_cost', { precision: 12, scale: 6 }).notNull().default('0'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    uniqueDate: uniqueIndex('uniq_owner_metrics_date').on(t.date),
    dateIdx: index('idx_owner_metrics_date').on(t.date),
  }),
);

export type OwnerDailyMetricRow = typeof ownerDailyMetrics.$inferSelect;
export type NewOwnerDailyMetric = typeof ownerDailyMetrics.$inferInsert;
