import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import { formatCellValue, humaniseHeader, inferHeaders } from '../utils/format.utils';
import type { IPdfExporter, PdfOptions, ReportData } from '../types/export.types';

import { type ModuleLoader, loadOrThrow } from './dynamic-loader';

/**
 * BE-21 — pdfkit-based PDF generator.
 *
 * The output is intentionally simple — branded header, metadata
 * block, optional summary, then a paginated table of the data rows.
 * pdfkit was chosen over headless-Chromium pipelines because:
 *
 *   1. It streams output (we collect chunks into a Buffer so the
 *      caller can hash + S3-upload it).
 *   2. No Chromium dependency to keep the API container slim and
 *      cold-start fast.
 *   3. The visual budget for V1 is "looks decent printed" — no need
 *      for full HTML/CSS layout fidelity.
 *
 * Tables are paginated automatically when the data overflows a
 * page; alternating row fills give a CSV-style readability without
 * fighting pdfkit's text positioning model.
 *
 * Like the Excel exporter, the actual `pdfkit` package is
 * dynamic-imported so the unit tests can run with a stub.
 */

interface PdfKitDocument {
  page: {
    width: number;
    height: number;
    margins: { top: number; bottom: number; left: number; right: number };
  };
  y: number;
  on(event: 'data', cb: (chunk: Buffer) => void): PdfKitDocument;
  on(event: 'end', cb: () => void): PdfKitDocument;
  on(event: 'error', cb: (err: Error) => void): PdfKitDocument;
  fontSize(size: number): PdfKitDocument;
  font(name: string): PdfKitDocument;
  fillColor(color: string): PdfKitDocument;
  strokeColor(color: string): PdfKitDocument;
  text(text: string, options?: Record<string, unknown>): PdfKitDocument;
  text(text: string, x: number, y: number, options?: Record<string, unknown>): PdfKitDocument;
  moveDown(lines?: number): PdfKitDocument;
  moveTo(x: number, y: number): PdfKitDocument;
  lineTo(x: number, y: number): PdfKitDocument;
  stroke(): PdfKitDocument;
  rect(x: number, y: number, w: number, h: number): PdfKitDocument;
  fill(color?: string): PdfKitDocument;
  addPage(opts?: Record<string, unknown>): PdfKitDocument;
  switchToPage(index: number): PdfKitDocument;
  bufferedPageRange(): { start: number; count: number };
  end(): void;
  widthOfString(text: string, opts?: Record<string, unknown>): number;
}

interface PdfKitConstructor {
  new (opts?: Record<string, unknown>): PdfKitDocument;
}

const TEXT = '#1F2937';
const MUTED = '#6B7280';
const RULE = '#E5E7EB';
const BRAND = '#4F46E5';
const ROW_ALT = '#F9FAFB';
const TABLE_LEFT = 50;
const TABLE_RIGHT = 545;
const TABLE_WIDTH = TABLE_RIGHT - TABLE_LEFT;

@Injectable()
export class PdfExporterService implements IPdfExporter {
  private moduleLoader: ModuleLoader<PdfKitConstructor> = async () => {
    const mod = (await import('pdfkit').catch(() => null)) as
      | { default?: PdfKitConstructor }
      | PdfKitConstructor
      | null;
    if (!mod) throw new Error('Module pdfkit is not installed');
    if (typeof mod === 'function') return mod;
    if (typeof (mod as { default?: PdfKitConstructor }).default === 'function') {
      return (mod as { default: PdfKitConstructor }).default;
    }
    throw new Error('pdfkit module does not expose a constructor');
  };

  constructor(private readonly logger: LoggerService) {}

  /** Test seam — swap the dynamic loader for a stub. */
  __setModuleLoader(loader: ModuleLoader<PdfKitConstructor>): void {
    this.moduleLoader = loader;
  }

  async generate(data: ReportData, options: PdfOptions): Promise<Buffer> {
    const Ctor = await loadOrThrow('pdfkit', this.moduleLoader);
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      const doc = new Ctor({
        size: options.pageSize ?? 'A4',
        layout: options.orientation ?? 'portrait',
        margin: 50,
        bufferPages: true,
        info: {
          Title: options.title,
          Author: options.generatedBy,
          Creator: 'RADHA Platform',
          CreationDate: options.generatedAt,
        },
      });

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks));
        }
      });
      doc.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      try {
        this.layout(doc, data, options);
        if (options.pageNumbers !== false) this.paintPageNumbers(doc);
        doc.end();
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err as Error);
        }
      }
    });
  }

  /* ─────────────────── layout ─────────────────── */

  private layout(doc: PdfKitDocument, data: ReportData, options: PdfOptions): void {
    this.paintHeader(doc, options);
    this.paintTitle(doc, options);
    this.paintMetadata(doc, options);
    if (data.summary && Object.keys(data.summary).length > 0) {
      this.paintSummary(doc, data.summary);
    }
    if (data.rows.length > 0) {
      this.paintTable(doc, data.rows, options);
    } else {
      doc.fontSize(11).fillColor(MUTED).text('(no rows in this report)', { align: 'center' });
    }
    if (options.watermark) this.paintWatermark(doc, options.watermark);
  }

  private paintHeader(doc: PdfKitDocument, options: PdfOptions): void {
    doc.fontSize(10).fillColor(BRAND).text('RADHA', 50, 45);
    doc.fontSize(8).fillColor(MUTED).text(options.generatedAt.toISOString(), 50, 45, {
      align: 'right',
      width: TABLE_WIDTH,
    });
    doc.moveTo(50, 70).lineTo(545, 70).strokeColor(RULE).stroke();
    doc.y = 80;
  }

  private paintTitle(doc: PdfKitDocument, options: PdfOptions): void {
    doc.fontSize(20).fillColor(TEXT).text(options.title, { align: 'center' });
    if (options.subtitle) {
      doc.moveDown(0.25);
      doc.fontSize(11).fillColor(MUTED).text(options.subtitle, { align: 'center' });
    }
    doc.moveDown(0.75);
  }

  private paintMetadata(doc: PdfKitDocument, options: PdfOptions): void {
    const rows: Array<[string, string]> = [
      ['Tenant', options.tenantName],
      ...(options.storeName ? ([['Store', options.storeName]] as Array<[string, string]>) : []),
      ['Generated By', options.generatedBy],
      ['Generated At', options.generatedAt.toISOString()],
      ...(options.dateRange
        ? ([
            [
              'Date Range',
              `${options.dateRange.from.toISOString().slice(0, 10)} → ${options.dateRange.to
                .toISOString()
                .slice(0, 10)}`,
            ],
          ] as Array<[string, string]>)
        : []),
    ];

    doc.fontSize(10).fillColor(TEXT);
    let y = doc.y;
    for (const [label, value] of rows) {
      doc.font('Helvetica-Bold').text(`${label}:`, 50, y, { continued: false, width: 95 });
      doc.font('Helvetica').text(value, 150, y, { width: TABLE_WIDTH - 100 });
      y += 14;
    }
    doc.y = y + 8;
  }

  private paintSummary(doc: PdfKitDocument, summary: Record<string, unknown>): void {
    doc.fontSize(13).fillColor(TEXT).font('Helvetica-Bold').text('Summary');
    doc.moveDown(0.25);
    doc.fontSize(10).font('Helvetica');
    for (const [k, v] of Object.entries(summary)) {
      doc.fillColor(TEXT).text(`${humaniseHeader(k)}: ${formatCellValue(v)}`);
    }
    doc.moveDown(0.75);
  }

  private paintTable(
    doc: PdfKitDocument,
    rows: Record<string, unknown>[],
    options: PdfOptions,
  ): void {
    doc.fontSize(13).fillColor(TEXT).font('Helvetica-Bold').text('Details');
    doc.moveDown(0.25);

    const headers = inferHeaders(rows);
    if (headers.length === 0) return;
    const colWidth = TABLE_WIDTH / headers.length;
    const headerHeight = 18;
    const rowHeight = 14;
    const maxRows = options.maxRows ?? 200;

    const drawHeader = (yStart: number) => {
      doc.rect(TABLE_LEFT, yStart, TABLE_WIDTH, headerHeight).fill(BRAND);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#FFFFFF');
      headers.forEach((h, i) => {
        doc.text(humaniseHeader(h), TABLE_LEFT + i * colWidth + 4, yStart + 4, {
          width: colWidth - 8,
          ellipsis: true,
        });
      });
      return yStart + headerHeight;
    };

    let cursor = drawHeader(doc.y);
    const limit = Math.min(rows.length, maxRows);

    for (let i = 0; i < limit; i++) {
      const row = rows[i] as Record<string, unknown>;
      const pageBottom = doc.page.height - doc.page.margins.bottom - 30;
      if (cursor + rowHeight > pageBottom) {
        doc.addPage();
        cursor = drawHeader(50);
      }

      if (i % 2 === 0) {
        doc.rect(TABLE_LEFT, cursor, TABLE_WIDTH, rowHeight).fill(ROW_ALT);
      }
      doc.fontSize(8).font('Helvetica').fillColor(TEXT);
      headers.forEach((h, j) => {
        doc.text(formatCellValue(row[h]), TABLE_LEFT + j * colWidth + 4, cursor + 3, {
          width: colWidth - 8,
          ellipsis: true,
        });
      });
      cursor += rowHeight;
    }

    if (rows.length > limit) {
      doc.y = cursor + 6;
      doc
        .fontSize(9)
        .fillColor(MUTED)
        .font('Helvetica-Oblique')
        .text(`… ${rows.length - limit} more rows truncated. Download Excel for complete data.`, {
          align: 'center',
        });
      doc.font('Helvetica');
    } else {
      doc.y = cursor + 6;
    }
  }

  private paintWatermark(doc: PdfKitDocument, watermark: string): void {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(40)
        .fillColor(MUTED)
        .text(watermark, 0, doc.page.height / 2, { align: 'center', width: doc.page.width });
    }
  }

  private paintPageNumbers(doc: PdfKitDocument): void {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .font('Helvetica')
        .text(`Page ${i - range.start + 1} of ${range.count}`, 0, doc.page.height - 30, {
          align: 'center',
          width: doc.page.width,
        });
    }
  }
}
