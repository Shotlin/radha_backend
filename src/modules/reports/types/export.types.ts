/**
 * BE-21 — Export contracts.
 *
 * The exporter layer is intentionally decoupled from BE-20 (Report
 * Generation). Anyone with a `ReportData` payload can call into the
 * exporters; how that payload was assembled is none of our business.
 *
 * `ReportFormat` matches the `report_format` enum in
 * `@/db/schema/reports` so the repository round-trips cleanly.
 */

export type ReportFormat = 'pdf' | 'xlsx' | 'csv' | 'json';

export const REPORT_FORMATS: readonly ReportFormat[] = ['pdf', 'xlsx', 'csv', 'json'] as const;

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Input payload every exporter understands.
 *
 *   - `rows`     : flat tabular data (one record per row).
 *   - `summary`  : key/value KPI block rendered above the table.
 *   - `sheets`   : optional multi-sheet structure for Excel. When
 *                  present, `rows` is ignored by the Excel exporter.
 *   - `charts`   : chart definitions referenced by the PDF exporter.
 */
export interface ReportData {
  rows: Record<string, unknown>[];
  summary?: Record<string, unknown>;
  sheets?: ExcelSheet[];
  charts?: ChartConfig[];
}

export interface ExportOptions {
  title: string;
  subtitle?: string;
  generatedAt: Date;
  generatedBy: string;
  tenantName: string;
  storeName?: string;
  dateRange?: DateRange;
  watermark?: string;
}

export interface ExcelOptions extends ExportOptions {
  sheetName?: string;
  autoFilter?: boolean;
  freezeHeader?: boolean;
  conditionalFormatting?: boolean;
  /** Map of column key → width in characters. */
  columnWidths?: Record<string, number>;
}

export interface PdfOptions extends ExportOptions {
  orientation?: 'portrait' | 'landscape';
  pageSize?: 'A4' | 'Letter';
  pageNumbers?: boolean;
  /** Truncate the data table after this many rows. Default 200. */
  maxRows?: number;
}

export interface CsvOptions {
  delimiter?: string;
  quote?: string;
  escape?: string;
  header?: boolean;
  /** UTF-8 is the default; UTF-16 LE is supported for legacy Excel. */
  encoding?: 'utf8' | 'utf16le';
  /** Prepend a UTF-8 BOM so Excel auto-detects the encoding. */
  bom?: boolean;
}

export interface ExcelSheet {
  name: string;
  data: Record<string, unknown>[];
  columnWidths?: Record<string, number>;
}

export interface ChartConfig {
  type: 'bar' | 'line' | 'pie' | 'doughnut';
  title: string;
  data: ChartData;
}

export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string;
  }>;
}

/* ─────────────────── Exporter contracts ─────────────────── */

export interface IExcelExporter {
  generate(data: ReportData, options: ExcelOptions): Promise<Buffer>;
  generateMultiSheet(sheets: ExcelSheet[], options: ExcelOptions): Promise<Buffer>;
}

export interface IPdfExporter {
  generate(data: ReportData, options: PdfOptions): Promise<Buffer>;
}

export interface ICsvExporter {
  generate(rows: Record<string, unknown>[], options?: CsvOptions): Promise<Buffer>;
  stream(rows: AsyncIterable<Record<string, unknown>>, options?: CsvOptions): NodeJS.ReadableStream;
}

/* ─────────────────── Orchestrator contracts ─────────────────── */

export interface ExportRequest {
  reportId: string;
  tenantId: string;
  formats: ReportFormat[];
  data: ReportData;
  options: ExportOptions;
  /**
   * Override the default 90-day retention window. Passed through to
   * the `report_files.expires_at` column.
   */
  retentionDays?: number;
}

export interface ExportedFile {
  id: string;
  reportId: string;
  format: ReportFormat;
  s3Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  expiresAt: Date;
}

export interface ExportResult {
  reportId: string;
  files: ExportedFile[];
  totalSizeBytes: number;
  durationMs: number;
}

/**
 * Token used to register a `ReportDataLoader` from the BE-20 module.
 *
 * BE-21 ships a default loader that throws — BE-20 replaces it with a
 * real one that hits the `reports` repository. This keeps the
 * generation phase independent of the export phase.
 */
export const REPORT_DATA_LOADER = Symbol('REPORT_DATA_LOADER');

export interface ReportDataLoader {
  /**
   * Load already-generated report data for export.
   *
   * BE-20 will provide an implementation that hydrates from the
   * `reports.summary` JSONB column plus a regenerated dataset.
   */
  load(
    reportId: string,
    tenantId: string,
  ): Promise<{
    data: ReportData;
    options: ExportOptions;
  }>;
}

export interface IExportService {
  /** Export an in-memory `ReportData` payload to one or more formats. */
  exportData(request: ExportRequest, userId: string): Promise<ExportResult>;

  /** Convenience: export an existing report by id (uses ReportDataLoader). */
  exportReport(
    reportId: string,
    tenantId: string,
    formats: ReportFormat[],
    userId: string,
  ): Promise<ExportResult>;
}

export interface IReportDownloadService {
  /** Generate a presigned URL for a tracked report file. */
  getDownloadUrl(
    fileId: string,
    tenantId: string,
    expirySeconds?: number,
  ): Promise<{ url: string; expiresAt: Date; fileName: string }>;

  /** Same as above but routed by (reportId, format). */
  getDownloadUrlByFormat(
    reportId: string,
    tenantId: string,
    format: ReportFormat,
    expirySeconds?: number,
  ): Promise<{ url: string; expiresAt: Date; fileName: string }>;
}
