import type {
  DailyStoreMetricRow,
  ReportFileRow,
  ReportRow,
  ReportScheduleRow,
} from '@/db/schema/reports';

/**
 * BE-20 — Public types of the Report Generation Engine.
 *
 * Every value crossing a process boundary (HTTP, queue, DB JSON
 * column) is described here. Generators consume these shapes; the
 * controller projects results into responses 1:1.
 */

export type ReportType =
  | 'expiry-summary'
  | 'ean-mismatch'
  | 'scan-history'
  | 'task-completion'
  | 'inventory-summary'
  | 'grn-history'
  | 'health-distribution'
  | 'audit-trail'
  | 'dashboard';

export type ReportFormat = 'pdf' | 'xlsx' | 'csv' | 'json';

export type ReportStatus =
  | 'pending'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type ReportScheduleFrequency = 'daily' | 'weekly' | 'monthly';
export type ReportScheduleStatus = 'active' | 'paused' | 'cancelled';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface GenerateReportParams {
  type: ReportType;
  formats: ReportFormat[];
  storeIds?: string[];
  dateRange: DateRange;
  filters?: Record<string, unknown>;
  groupBy?: string[];
  includeCharts?: boolean;
  /** Optional title override. Defaults to `<type> – <range>`. */
  title?: string;
}

export interface ReportGenerationResult {
  reportId: string;
  status: ReportStatus;
  estimatedDurationSeconds: number;
  /** The pre-allocated report-file rows, one per requested format. */
  formats: ReportFormat[];
}

export interface ReportSummary {
  reportId: string;
  status: ReportStatus;
  type: ReportType;
  title: string;
  rowCount: number | null;
  summary: Record<string, unknown>;
  errorMessage: string | null;
  durationMs: number | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ReportWithFiles extends ReportRow {
  files: ReportFileRow[];
}

export interface ListReportsFilters {
  type?: ReportType;
  status?: ReportStatus;
  storeId?: string;
  requestedBy?: string;
  fromDate?: Date;
  toDate?: Date;
  limit: number;
}

export interface ScheduleReportParams {
  type: ReportType;
  title: string;
  storeId?: string;
  frequency: ReportScheduleFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  hourOfDay: number;
  parameters: GenerateReportParams;
  recipients?: string[];
}

/* ─────────────────── Generator outputs ─────────────────── */

/**
 * Generators are pure data producers: they return a `summary` block
 * (used by the dashboard list view) and `rows` (the body of any
 * exported file). BE-21 turns rows into PDF / Excel / CSV.
 */
export interface ReportData<TRow = Record<string, unknown>> {
  summary: Record<string, unknown>;
  rows: TRow[];
  meta?: Record<string, unknown>;
  generatedAt: Date;
}

export interface ExpirySummaryRow extends Record<string, unknown> {
  expiryRecordId: string;
  productId: string;
  productName: string;
  brand: string | null;
  ean: string;
  category: string | null;
  storeId: string;
  storeName: string | null;
  expiryDate: Date;
  daysRemaining: number | null;
  status: string;
  quantity: number;
  remainingQuantity: number;
  batchNumber: string | null;
}

export interface EanMismatchRow extends Record<string, unknown> {
  scanItemId: string;
  sessionId: string;
  storeId: string;
  storeName: string | null;
  userId: string;
  userName: string | null;
  ean: string;
  productId: string | null;
  productName: string | null;
  scannedAt: Date;
  matchStatus: string;
  /** Identifier of the active EAN list at time of scan, if any. */
  eanListId: string | null;
}

export interface ScanHistoryRow extends Record<string, unknown> {
  scanItemId: string;
  sessionId: string;
  storeId: string;
  storeName: string | null;
  userId: string;
  userName: string | null;
  ean: string;
  productId: string | null;
  productName: string | null;
  matchStatus: string;
  expiryStatus: string;
  scannedAt: Date;
}

export interface TaskCompletionRow extends Record<string, unknown> {
  taskId: string;
  title: string;
  status: string;
  assignedTo: string | null;
  assignedBy: string | null;
  storeId: string | null;
  createdAt: Date;
  dueAt: Date | null;
  completedAt: Date | null;
  durationMinutes: number | null;
}

export interface AuditTrailRow extends Record<string, unknown> {
  auditLogId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  userId: string | null;
  occurredAt: Date;
  success: boolean;
  errorCode: string | null;
}

export interface HealthDistributionRow extends Record<string, unknown> {
  grade: string;
  status: string;
  childSafety: string;
  count: number;
}

/* ─────────────────── Dashboard ─────────────────── */

export interface DashboardSummary {
  storeId: string;
  dateRange: DateRange;
  totals: {
    scans: number;
    sessionsCompleted: number;
    expiryRecords: number;
    activeAlerts: number;
    tasksCompleted: number;
    tasksOverdue: number;
  };
  expiry: {
    green: number;
    yellow: number;
    red: number;
    expired: number;
    unknown: number;
  };
  scanHealth: {
    matched: number;
    unmatched: number;
    matchRate: number;
  };
  trends: DashboardTrendPoint[];
  topProducts: Array<{ productId: string; productName: string; scanCount: number }>;
  topUsers: Array<{ userId: string; userName: string; scanCount: number }>;
  generatedAt: Date;
}

export interface DashboardTrendPoint {
  date: string; // YYYY-MM-DD
  scans: number;
  expiryAdded: number;
  tasksCompleted: number;
}

/* ─────────────────── Aggregator ─────────────────── */

export interface AggregationResult {
  date: string;
  storesProcessed: number;
  rowsUpserted: number;
}

export type DailyStoreMetric = DailyStoreMetricRow;

/* ─────────────────── Re-exports ─────────────────── */

export type Report = ReportRow;
export type ReportFile = ReportFileRow;
export type ReportSchedule = ReportScheduleRow;

/**
 * Generator interface — every concrete generator implements this so
 * `ReportGeneratorService` can dispatch by type without coupling to
 * the implementation.
 */
export interface IReportGenerator<TRow = Record<string, unknown>> {
  readonly type: ReportType;
  generate(params: GenerateReportParams, tenantId: string): Promise<ReportData<TRow>>;
}
