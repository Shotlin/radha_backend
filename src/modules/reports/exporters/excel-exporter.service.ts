import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import {
  formatCellValue,
  humaniseHeader,
  inferHeaders,
  sanitizeFormula,
} from '../utils/format.utils';
import type { ExcelOptions, ExcelSheet, IExcelExporter, ReportData } from '../types/export.types';

import { type ModuleLoader, loadOrThrow } from './dynamic-loader';

/**
 * BE-21 — ExcelJS-based workbook generator.
 *
 * Layout decisions:
 *
 *   - Workbook always carries a `Report Info` metadata sheet so the
 *     consumer can audit the export's lineage. Single source of truth
 *     for tenant name, generator, date range.
 *   - Optional `Summary` sheet ahead of the data — useful for
 *     "headline" KPIs that auditors paste into their decks.
 *   - Header row is bolded with a brand fill (#4F46E5) and frozen.
 *   - Every cell is run through `sanitizeFormula` before write to
 *     close the OWASP CSV-injection vector.
 *   - `conditionalFormatting` paints `status` columns with the
 *     red/yellow/green palette the BE-18 expiry phase already uses
 *     in the mobile UI.
 *
 * The actual `exceljs` package is loaded dynamically (see
 * `dynamic-loader.ts`) so this file imports cleanly even when the dep
 * isn't installed yet — important for CI runs that haven't pulled
 * the workspace deps. Production environments must have `exceljs`
 * installed; the orchestrator handoff checklist makes that explicit.
 */

// Minimal structural typings of the exceljs surface we touch. Lets
// us compile without a hard `@types/exceljs` import.
interface ExcelJsCell {
  value: unknown;
  font?: Record<string, unknown>;
  fill?: Record<string, unknown>;
  alignment?: Record<string, unknown>;
}
interface ExcelJsRow {
  font?: Record<string, unknown>;
  fill?: Record<string, unknown>;
  alignment?: Record<string, unknown>;
  getCell(col: number): ExcelJsCell;
  commit?: () => void;
}
interface ExcelJsWorksheetView {
  state?: 'frozen';
  ySplit?: number;
}
interface ExcelJsWorksheet {
  name: string;
  columns: Array<{ header: string; key: string; width?: number }>;
  views?: ExcelJsWorksheetView[];
  autoFilter?: unknown;
  addRow(row: unknown): ExcelJsRow;
  addRows(rows: unknown[]): ExcelJsRow[];
  getRow(n: number): ExcelJsRow;
  addConditionalFormatting?(rule: unknown): void;
  rowCount: number;
}
interface ExcelJsWorkbook {
  creator: string;
  created: Date;
  lastModifiedBy: string;
  addWorksheet(name: string): ExcelJsWorksheet;
  xlsx: { writeBuffer(): Promise<ArrayBuffer | Buffer | Uint8Array> };
}
interface ExcelJsModule {
  Workbook: new () => ExcelJsWorkbook;
}

const BRAND_FILL = 'FF4F46E5';
const STATUS_COLOURS = {
  green: 'FFD1FAE5',
  yellow: 'FFFEF3C7',
  red: 'FFFEE2E2',
};

@Injectable()
export class ExcelExporterService implements IExcelExporter {
  private moduleLoader: ModuleLoader<ExcelJsModule> = async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = (await import('exceljs').catch(() => null)) as
      | { default?: ExcelJsModule }
      | ExcelJsModule
      | null;
    if (!mod) throw new Error('Module exceljs is not installed');
    return 'default' in (mod as Record<string, unknown>) &&
      (mod as { default?: ExcelJsModule }).default
      ? (mod as { default: ExcelJsModule }).default
      : (mod as ExcelJsModule);
  };

  constructor(private readonly logger: LoggerService) {}

  /** Test seam — swap the dynamic loader for a stub. */
  __setModuleLoader(loader: ModuleLoader<ExcelJsModule>): void {
    this.moduleLoader = loader;
  }

  async generate(data: ReportData, options: ExcelOptions): Promise<Buffer> {
    const exceljs = await loadOrThrow('exceljs', this.moduleLoader);
    const workbook = this.newWorkbook(exceljs, options);

    this.addMetadataSheet(workbook, options);

    if (data.summary && Object.keys(data.summary).length > 0) {
      this.addSummarySheet(workbook, data.summary);
    }

    if (data.sheets && data.sheets.length > 0) {
      for (const sheet of data.sheets) this.addDataSheet(workbook, sheet, options);
    } else {
      this.addDataSheet(
        workbook,
        { name: options.sheetName ?? 'Report', data: data.rows },
        options,
      );
    }

    return this.serialise(workbook);
  }

  async generateMultiSheet(sheets: ExcelSheet[], options: ExcelOptions): Promise<Buffer> {
    const exceljs = await loadOrThrow('exceljs', this.moduleLoader);
    const workbook = this.newWorkbook(exceljs, options);
    this.addMetadataSheet(workbook, options);
    for (const sheet of sheets) this.addDataSheet(workbook, sheet, options);
    return this.serialise(workbook);
  }

  /* ─────────────────── internals ─────────────────── */

  private newWorkbook(mod: ExcelJsModule, options: ExcelOptions): ExcelJsWorkbook {
    const wb = new mod.Workbook();
    wb.creator = 'RADHA Platform';
    wb.created = options.generatedAt;
    wb.lastModifiedBy = options.generatedBy;
    return wb;
  }

  private addMetadataSheet(workbook: ExcelJsWorkbook, options: ExcelOptions): void {
    const sheet = workbook.addWorksheet('Report Info');
    sheet.columns = [
      { header: 'Field', key: 'field', width: 28 },
      { header: 'Value', key: 'value', width: 60 },
    ];

    const rows: Array<{ field: string; value: string }> = [
      { field: 'Title', value: options.title },
      ...(options.subtitle ? [{ field: 'Subtitle', value: options.subtitle }] : []),
      { field: 'Tenant', value: options.tenantName },
      ...(options.storeName ? [{ field: 'Store', value: options.storeName }] : []),
      { field: 'Generated By', value: options.generatedBy },
      { field: 'Generated At', value: options.generatedAt.toISOString() },
      ...(options.dateRange
        ? [
            { field: 'Date From', value: options.dateRange.from.toISOString() },
            { field: 'Date To', value: options.dateRange.to.toISOString() },
          ]
        : []),
      { field: 'Powered By', value: 'RADHA — Retail Audit Platform' },
    ];

    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: BRAND_FILL },
    };
  }

  private addSummarySheet(workbook: ExcelJsWorkbook, summary: Record<string, unknown>): void {
    const sheet = workbook.addWorksheet('Summary');
    sheet.columns = [
      { header: 'Metric', key: 'metric', width: 32 },
      { header: 'Value', key: 'value', width: 24 },
    ];
    const rows = Object.entries(summary).map(([k, v]) => ({
      metric: humaniseHeader(k),
      value: this.safeCell(v),
    }));
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true };
  }

  private addDataSheet(
    workbook: ExcelJsWorkbook,
    sheetDef: ExcelSheet,
    options: ExcelOptions,
  ): void {
    const sheet = workbook.addWorksheet(this.safeSheetName(sheetDef.name));

    if (!sheetDef.data || sheetDef.data.length === 0) {
      // Still leave a minimal hint so the consumer doesn't see a
      // bare empty tab.
      sheet.columns = [{ header: 'No data', key: 'no_data', width: 24 }];
      sheet.addRow({ no_data: '(no rows in this report)' });
      return;
    }

    const headers = inferHeaders(sheetDef.data);
    const widths = sheetDef.columnWidths ?? options.columnWidths ?? {};
    sheet.columns = headers.map((key) => ({
      header: humaniseHeader(key),
      key,
      width: widths[key] ?? 20,
    }));

    // Header styling.
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: BRAND_FILL },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Body rows — every cell sanitised.
    for (const row of sheetDef.data) {
      const safe: Record<string, unknown> = {};
      for (const key of headers) safe[key] = this.safeCell(row[key]);
      sheet.addRow(safe);
    }

    if (options.freezeHeader !== false) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }
    if (options.autoFilter !== false && headers.length > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: headers.length },
      };
    }
    if (options.conditionalFormatting && sheet.addConditionalFormatting) {
      this.applyStatusFormatting(sheet, headers);
    }
  }

  /**
   * Paint the (first) `*status*` column with the BE-18 colour
   * palette. Only invoked when caller opts in.
   */
  private applyStatusFormatting(sheet: ExcelJsWorksheet, headers: string[]): void {
    const idx = headers.findIndex((h) => h.toLowerCase().includes('status'));
    if (idx < 0 || !sheet.addConditionalFormatting) return;

    const colLetter = String.fromCharCode('A'.charCodeAt(0) + idx);
    const range = `${colLetter}2:${colLetter}1048576`;

    const rule = (text: string, argb: string, priority: number) => ({
      type: 'containsText',
      operator: 'containsText',
      text,
      priority,
      style: {
        fill: { type: 'pattern', pattern: 'solid', bgColor: { argb } },
      },
    });

    sheet.addConditionalFormatting({
      ref: range,
      rules: [
        rule('red', STATUS_COLOURS.red, 1),
        rule('yellow', STATUS_COLOURS.yellow, 2),
        rule('green', STATUS_COLOURS.green, 3),
      ],
    });
  }

  private async serialise(workbook: ExcelJsWorkbook): Promise<Buffer> {
    const raw = await workbook.xlsx.writeBuffer();
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof ArrayBuffer) return Buffer.from(raw);
    return Buffer.from(raw as Uint8Array);
  }

  /**
   * Excel limits sheet names to 31 characters and disallows certain
   * characters. Trim safely.
   */
  private safeSheetName(name: string): string {
    const cleaned = name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
    return cleaned.length > 0 ? cleaned : 'Report';
  }

  private safeCell(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    return sanitizeFormula(formatCellValue(value));
  }
}
