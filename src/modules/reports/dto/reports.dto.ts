import { z } from 'zod';

/**
 * BE-21 — Reports/Export DTOs.
 *
 * A single file holds every Zod schema the controller binds to,
 * mirroring the `dto/expiry.dto.ts` convention used elsewhere in the
 * codebase.
 */

const REPORT_FORMATS = ['pdf', 'xlsx', 'csv', 'json'] as const;

/** Static segments must resolve before `:id`, so the controller has
 *  three distinct query schemas — list / lookup / download. */
export const ListReportFilesQuerySchema = z.object({
  reportId: z.string().uuid(),
});
export type ListReportFilesQueryDto = z.infer<typeof ListReportFilesQuerySchema>;

export const DownloadByFormatParamSchema = z.object({
  format: z.enum(REPORT_FORMATS),
});
export type DownloadByFormatParamDto = z.infer<typeof DownloadByFormatParamSchema>;

/**
 * Optional `expiry` query — must stay between 60 s and 7 days. We cap
 * at 7 days because anything longer than that should be a fresh
 * presigned URL, not a long-lived shared link.
 */
export const DownloadQuerySchema = z.object({
  expirySeconds: z.coerce
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 3600)
    .default(24 * 3600),
});
export type DownloadQueryDto = z.infer<typeof DownloadQuerySchema>;

/** Body for ad-hoc exports (`POST /api/v1/reports/export`). */
export const AdHocExportBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    subtitle: z.string().max(300).optional(),
    formats: z.array(z.enum(REPORT_FORMATS)).min(1).max(REPORT_FORMATS.length),
    /**
     * Hard cap at 100 K rows. Anything bigger should go through a
     * BE-24 background job.
     */
    rows: z.array(z.record(z.string(), z.unknown())).max(100_000),
    summary: z.record(z.string(), z.unknown()).optional(),
    storeName: z.string().max(200).optional(),
    tenantName: z.string().min(1).max(200),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    retentionDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .refine((d) => !d.dateFrom || !d.dateTo || d.dateTo.getTime() >= d.dateFrom.getTime(), {
    message: 'dateTo must be on or after dateFrom',
    path: ['dateTo'],
  });
export type AdHocExportBodyDto = z.infer<typeof AdHocExportBodySchema>;

/** Body for re-exporting an existing BE-20 report. */
export const ExportExistingReportBodySchema = z.object({
  formats: z.array(z.enum(REPORT_FORMATS)).min(1).max(REPORT_FORMATS.length),
});
export type ExportExistingReportBodyDto = z.infer<typeof ExportExistingReportBodySchema>;

/* ──────────────────────────────────────────────────────────────────
 * BE-20 — Generation, scheduling and dashboard DTOs.
 *
 * Co-located with the BE-21 export schemas so consumers only need to
 * pull from one file. The two phases share `REPORT_FORMATS` above.
 * ────────────────────────────────────────────────────────────────── */

const REPORT_TYPES = [
  'expiry-summary',
  'ean-mismatch',
  'scan-history',
  'task-completion',
  'inventory-summary',
  'grn-history',
  'health-distribution',
  'audit-trail',
  'dashboard',
] as const;

const REPORT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
  'expired',
  'cancelled',
] as const;

const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

const MAX_RANGE_DAYS = 365;

const dateRangeSchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((d) => d.from.getTime() < d.to.getTime(), {
    message: 'dateRange.to must be after dateRange.from',
    path: ['to'],
  })
  .refine(
    (d) =>
      Math.floor((d.to.getTime() - d.from.getTime()) / (1000 * 60 * 60 * 24)) <= MAX_RANGE_DAYS,
    { message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`, path: ['to'] },
  );

/* ─────────────────── Generate ─────────────────── */

export const GenerateReportSchema = z.object({
  type: z.enum(REPORT_TYPES),
  formats: z
    .array(z.enum(REPORT_FORMATS))
    .min(1)
    .max(REPORT_FORMATS.length)
    .refine((arr) => new Set(arr).size === arr.length, 'formats must be unique'),
  storeIds: z.array(z.string().uuid()).max(50).optional(),
  dateRange: dateRangeSchema,
  filters: z.record(z.unknown()).optional(),
  groupBy: z.array(z.string().min(1).max(64)).max(5).optional(),
  includeCharts: z.coerce.boolean().optional().default(false),
  title: z.string().min(1).max(200).optional(),
});
export type GenerateReportDto = z.infer<typeof GenerateReportSchema>;

/* ─────────────────── List ─────────────────── */

export const ListReportsQuerySchema = z.object({
  type: z.enum(REPORT_TYPES).optional(),
  status: z.enum(REPORT_STATUSES).optional(),
  storeId: z.string().uuid().optional(),
  requestedBy: z.string().uuid().optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListReportsQueryDto = z.infer<typeof ListReportsQuerySchema>;

/* ─────────────────── Dashboard ─────────────────── */

export const DashboardQuerySchema = z
  .object({
    storeId: z.string().uuid(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    daysAhead: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).optional(),
  })
  .transform((value) => {
    const to = value.to ?? new Date();
    const from =
      value.from ?? new Date(to.getTime() - (value.daysAhead ?? 30) * 24 * 60 * 60 * 1000);
    return { storeId: value.storeId, from, to };
  })
  .refine((d) => d.from.getTime() < d.to.getTime(), {
    message: 'Dashboard `to` must be after `from`',
    path: ['to'],
  });
export type DashboardQueryDto = z.infer<typeof DashboardQuerySchema>;

/* ─────────────────── Schedule ─────────────────── */

export const ScheduleReportSchema = z
  .object({
    type: z.enum(REPORT_TYPES),
    title: z.string().min(1).max(200),
    storeId: z.string().uuid().optional(),
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
    dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
    hourOfDay: z.coerce.number().int().min(0).max(23).default(2),
    parameters: GenerateReportSchema,
    recipients: z.array(z.string().uuid()).max(50).optional().default([]),
  })
  .refine((d) => d.frequency !== 'weekly' || d.dayOfWeek !== undefined, {
    message: 'dayOfWeek is required for weekly schedules',
    path: ['dayOfWeek'],
  })
  .refine((d) => d.frequency !== 'monthly' || d.dayOfMonth !== undefined, {
    message: 'dayOfMonth is required for monthly schedules',
    path: ['dayOfMonth'],
  });
export type ScheduleReportDto = z.infer<typeof ScheduleReportSchema>;

/* ─────────────────── Aggregation (admin) ─────────────────── */

const yesterdayUtcStart = (): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

export const AggregateMetricsBodySchema = z
  .object({
    date: z.coerce.date().optional(),
  })
  .transform((value) => ({
    date: value.date ?? yesterdayUtcStart(),
  }));
export type AggregateMetricsBodyDto = z.infer<typeof AggregateMetricsBodySchema>;
