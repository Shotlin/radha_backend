import { sql } from 'drizzle-orm';
import {
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * BE-20 — Report Generation Engine schema.
 *
 * Four tables in one file because they share lifecycle:
 *   reports               — meta of a generation run
 *   report_files          — produced artefact (one row per requested format)
 *   report_schedules      — recurring schedule definitions
 *   daily_store_metrics   — pre-aggregated rollup that powers dashboards in < 500 ms
 *
 * Tenant scoping is mandatory on `reports`, `report_schedules` and
 * `daily_store_metrics`. `report_files` inherits tenant scope through
 * its parent report row (cascade delete).
 *
 * The `reports.parameters` JSONB carries the exact payload the caller
 * sent so rerunning is byte-for-byte reproducible — handy for audit
 * trails and the BE-21 download phase.
 */

export const reportTypeEnum = pgEnum('report_type', [
  'expiry-summary',
  'ean-mismatch',
  'scan-history',
  'task-completion',
  'inventory-summary',
  'grn-history',
  'health-distribution',
  'audit-trail',
  'dashboard',
]);

export const reportStatusEnum = pgEnum('report_status', [
  'pending',
  'generating',
  'completed',
  'failed',
  'expired',
  'cancelled',
]);

export const reportFormatEnum = pgEnum('report_format', ['pdf', 'xlsx', 'csv', 'json']);

export const reportScheduleFrequencyEnum = pgEnum('report_schedule_frequency', [
  'daily',
  'weekly',
  'monthly',
]);

export const reportScheduleStatusEnum = pgEnum('report_schedule_status', [
  'active',
  'paused',
  'cancelled',
]);

export const reports = pgTable(
  'reports',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id'),

    type: reportTypeEnum('type').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    status: reportStatusEnum('status').notNull().default('pending'),

    /**
     * Exact request payload — the generator re-reads it on every run
     * so a recurring schedule never drifts away from the original
     * intent of the human who created it.
     */
    parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull(),

    dateFrom: timestamp('date_from', { withTimezone: true }),
    dateTo: timestamp('date_to', { withTimezone: true }),

    requestedBy: uuid('requested_by').notNull(),
    scheduleId: uuid('schedule_id'), // set when run was triggered by a schedule

    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    generationStartedAt: timestamp('generation_started_at', { withTimezone: true }),
    generationCompletedAt: timestamp('generation_completed_at', { withTimezone: true }),
    generationDurationMs: integer('generation_duration_ms'),

    rowCount: integer('row_count'),
    /** Quick stats useful for list views (e.g. red/yellow/green totals). */
    summary: jsonb('summary').$type<Record<string, unknown>>().default({}),
    errorMessage: varchar('error_message', { length: 1000 }),

    expiresAt: timestamp('expires_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantTypeIdx: index('reports_tenant_type_idx').on(t.tenantId, t.type),
    tenantStatusIdx: index('reports_tenant_status_idx').on(t.tenantId, t.status),
    storeCreatedIdx: index('reports_store_created_idx').on(t.storeId, t.createdAt),
    requestedByIdx: index('reports_requested_by_idx').on(t.requestedBy),
    expiresIdx: index('reports_expires_idx').on(t.expiresAt),
    scheduleIdx: index('reports_schedule_idx').on(t.scheduleId),
  }),
);

export type ReportRow = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;

export const reportFiles = pgTable(
  'report_files',
  {
    ...baseColumns,
    reportId: uuid('report_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),

    format: reportFormatEnum('format').notNull(),
    /** Either an S3 key (preferred) or null while generation is pending. */
    fileKey: varchar('file_key', { length: 500 }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    fileSize: integer('file_size'),
    /** SHA-256 of the artefact for verification before download serve. */
    checksum: varchar('checksum', { length: 128 }),

    expiresAt: timestamp('expires_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    reportIdx: index('report_files_report_idx').on(t.reportId),
    tenantIdx: index('report_files_tenant_idx').on(t.tenantId),
    /**
     * One row per (report, format). The generator is idempotent —
     * a retry replaces the same row by upserting on this key.
     */
    reportFormatUniq: uniqueIndex('report_files_report_format_uniq').on(t.reportId, t.format),
  }),
);

export type ReportFileRow = typeof reportFiles.$inferSelect;
export type NewReportFile = typeof reportFiles.$inferInsert;

export const reportSchedules = pgTable(
  'report_schedules',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id'),

    type: reportTypeEnum('type').notNull(),
    title: varchar('title', { length: 200 }).notNull(),

    frequency: reportScheduleFrequencyEnum('frequency').notNull(),
    /** Day-of-week (0=Sun..6=Sat) for weekly, day-of-month (1..28) for monthly. */
    dayOfWeek: integer('day_of_week'),
    dayOfMonth: integer('day_of_month'),
    /** Hour-of-day (0..23) in tenant timezone — BE-24 cron resolves zone. */
    hourOfDay: integer('hour_of_day').notNull().default(2),

    status: reportScheduleStatusEnum('status').notNull().default('active'),
    /** Persisted full GenerateReportDto payload — replayed on every fire. */
    parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull(),
    /** Recipients (user ids) for delivery — BE-24 notification fan-out. */
    recipients: jsonb('recipients').$type<string[]>().notNull().default([]),

    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunReportId: uuid('last_run_report_id'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantIdx: index('report_schedules_tenant_idx').on(t.tenantId),
    statusIdx: index('report_schedules_status_idx').on(t.status),
    nextRunIdx: index('report_schedules_next_run_idx').on(t.nextRunAt),
    typeIdx: index('report_schedules_type_idx').on(t.tenantId, t.type),
  }),
);

export type ReportScheduleRow = typeof reportSchedules.$inferSelect;
export type NewReportSchedule = typeof reportSchedules.$inferInsert;

export const dailyStoreMetrics = pgTable(
  'daily_store_metrics',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),
    /** UTC day boundary — `date_trunc('day', ...)`. */
    date: timestamp('date', { withTimezone: true }).notNull(),

    // Scan metrics
    totalScans: integer('total_scans').notNull().default(0),
    uniqueProducts: integer('unique_products').notNull().default(0),
    matchedScans: integer('matched_scans').notNull().default(0),
    unmatchedScans: integer('unmatched_scans').notNull().default(0),

    // Sessions
    sessionsStarted: integer('sessions_started').notNull().default(0),
    sessionsCompleted: integer('sessions_completed').notNull().default(0),

    // Expiry
    expiryRecordsAdded: integer('expiry_records_added').notNull().default(0),
    expiredItems: integer('expired_items').notNull().default(0),
    nearExpiryItems: integer('near_expiry_items').notNull().default(0),
    alertsGenerated: integer('alerts_generated').notNull().default(0),
    alertsResolved: integer('alerts_resolved').notNull().default(0),

    // Tasks (BE-19 dependency — populated when tasks table lands)
    tasksCreated: integer('tasks_created').notNull().default(0),
    tasksCompleted: integer('tasks_completed').notNull().default(0),
    tasksOverdue: integer('tasks_overdue').notNull().default(0),
    averageTaskMinutes: decimal('average_task_minutes', { precision: 10, scale: 2 }),

    activeUsers: integer('active_users').notNull().default(0),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    /**
     * One row per (store, day). Aggregator upserts on this key so
     * re-running is idempotent.
     */
    storeDateUniq: uniqueIndex('daily_metrics_store_date_uniq').on(t.storeId, t.date),
    tenantDateIdx: index('daily_metrics_tenant_date_idx').on(t.tenantId, t.date),
  }),
);

export type DailyStoreMetricRow = typeof dailyStoreMetrics.$inferSelect;
export type NewDailyStoreMetric = typeof dailyStoreMetrics.$inferInsert;
