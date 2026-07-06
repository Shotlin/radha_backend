import { Inject, Injectable, Optional } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ReportFilesRepository } from '../repositories/report-files.repository';
import { ReportStorageService } from '../services/report-storage.service';
import {
  type ExportRequest,
  type ExportResult,
  type ExportedFile,
  type IExportService,
  REPORT_DATA_LOADER,
  type ReportDataLoader,
  type ReportFormat,
} from '../types/export.types';
import {
  buildReportKey,
  computeExpiresAt,
  contentTypeFor,
  sha256Hex,
} from '../utils/storage-keys.utils';

import { CsvExporterService } from './csv-exporter.service';
import { ExcelExporterService } from './excel-exporter.service';
import { PdfExporterService } from './pdf-exporter.service';

/**
 * BE-21 — Orchestrator: data + format → uploaded artefacts.
 *
 * Steps per format:
 *   1. Render to a buffer with the format-specific exporter.
 *   2. Hash for integrity tracking (`sha256Hex`).
 *   3. Build a tenant-scoped S3 key (`buildReportKey`).
 *   4. Upload to S3 via `ReportStorageService`.
 *   5. UPSERT a `report_files` row keyed on `(report_id, format)`.
 *   6. Audit `EXPORT` action with metadata.transition='generated'.
 *
 * Multi-format requests render in parallel. The orchestrator
 * deliberately does NOT wrap the whole batch in a transaction —
 * each artefact is independently durable, and partial success is
 * better than all-or-nothing for end-users running large reports.
 *
 * BE-20 hookup:
 *   When BE-20 lands, it registers a `ReportDataLoader` provider
 *   bound to the `REPORT_DATA_LOADER` token. Until then,
 *   `exportReport()` throws a clear "not implemented" error. The
 *   `exportData()` method works standalone with caller-supplied data
 *   and is what BE-21's REST surface depends on.
 */
@Injectable()
export class ExportService implements IExportService {
  constructor(
    private readonly excel: ExcelExporterService,
    private readonly pdf: PdfExporterService,
    private readonly csv: CsvExporterService,
    private readonly storage: ReportStorageService,
    private readonly filesRepo: ReportFilesRepository,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
    @Optional()
    @Inject(REPORT_DATA_LOADER)
    private readonly dataLoader?: ReportDataLoader,
  ) {}

  async exportData(request: ExportRequest, userId: string): Promise<ExportResult> {
    const startedAt = Date.now();
    if (request.formats.length === 0) {
      throw new Error('At least one format is required');
    }

    // De-duplicate while preserving order.
    const formats = [...new Set(request.formats)];

    const files = await Promise.all(
      formats.map((fmt) => this.renderAndPersist(request, fmt, userId)),
    );

    const totalSizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    const durationMs = Date.now() - startedAt;

    this.logger.info('reports.export.completed', {
      reportId: request.reportId,
      tenantId: request.tenantId,
      formats,
      totalSizeBytes,
      durationMs,
    });

    return { reportId: request.reportId, files, totalSizeBytes, durationMs };
  }

  async exportReport(
    reportId: string,
    tenantId: string,
    formats: ReportFormat[],
    userId: string,
  ): Promise<ExportResult> {
    if (!this.dataLoader) {
      throw new Error(
        'ReportDataLoader is not registered. BE-20 (Report Generation) ' +
          'must provide a ReportDataLoader binding for REPORT_DATA_LOADER.',
      );
    }
    const { data, options } = await this.dataLoader.load(reportId, tenantId);
    return this.exportData({ reportId, tenantId, formats, data, options }, userId);
  }

  /* ─────────────────── internals ─────────────────── */

  private async renderAndPersist(
    request: ExportRequest,
    format: ReportFormat,
    userId: string,
  ): Promise<ExportedFile> {
    const buffer = await this.render(request, format);

    if (buffer.length === 0) {
      throw new Error(`Empty buffer produced for format ${format}`);
    }

    const checksum = sha256Hex(buffer);
    const key = buildReportKey({
      tenantId: request.tenantId,
      reportId: request.reportId,
      format,
      title: request.options.title,
    });
    const expiresAt = computeExpiresAt(request.retentionDays);

    await this.storage.upload(key.s3Key, buffer, key.contentType);

    const persisted = await this.filesRepo.upsert({
      reportId: request.reportId,
      tenantId: request.tenantId,
      format,
      fileKey: key.s3Key,
      fileName: key.fileName,
      contentType: key.contentType,
      fileSize: buffer.length,
      checksum,
      expiresAt,
      metadata: { generatedBy: userId },
    });

    await this.audit.logAction({
      action: 'EXPORT',
      resourceType: 'Report',
      resourceId: request.reportId,
      userId,
      tenantId: request.tenantId,
      success: true,
      metadata: {
        transition: 'generated',
        format,
        sizeBytes: buffer.length,
        checksum,
      },
    });

    return {
      id: persisted.id,
      reportId: persisted.reportId,
      format,
      s3Key: key.s3Key,
      fileName: key.fileName,
      contentType: key.contentType,
      sizeBytes: buffer.length,
      checksum,
      expiresAt,
    };
  }

  private async render(request: ExportRequest, format: ReportFormat): Promise<Buffer> {
    switch (format) {
      case 'xlsx':
        return this.excel.generate(request.data, {
          ...request.options,
          autoFilter: true,
          freezeHeader: true,
          conditionalFormatting: true,
        });
      case 'pdf':
        return this.pdf.generate(request.data, {
          ...request.options,
          orientation: 'portrait',
          pageSize: 'A4',
          pageNumbers: true,
        });
      case 'csv':
        return this.csv.generate(request.data.rows, {
          header: true,
          delimiter: ',',
          encoding: 'utf8',
          bom: true,
        });
      case 'json':
        return Buffer.from(
          JSON.stringify({ ...request.options, data: request.data }, null, 2),
          'utf8',
        );
      default: {
        const exhaustive: never = format;
        throw new Error(`Unsupported format: ${String(exhaustive)}`);
      }
    }
  }

  /** Test seam — used by `__tests__` to assert content-type wiring. */
  static __contentTypeFor(format: ReportFormat): string {
    return contentTypeFor(format);
  }
}
