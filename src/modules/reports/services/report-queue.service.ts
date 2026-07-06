import { Inject, Injectable, Optional } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ExportService } from '../exporters/export.service';
import { ReportsRepository } from '../repositories/reports.repository';
import { EXPORT_SERVICE, type IExportFacade } from '../types/queue.types';
import type {
  ExportOptions as Be21ExportOptions,
  ReportFormat as Be21ReportFormat,
} from '../types/export.types';
import type { GenerateReportParams, ReportType } from '../types/report.types';

import { ReportGeneratorService } from './report-generator.service';

/**
 * BE-20 — Report job runner.
 *
 * v1 ships a sync-mode-with-queue-shaped-API: the public method
 * `enqueue(reportId)` immediately runs the generator and (if the
 * BE-21 export service is wired) hands the data off for file
 * production. BE-24 will swap the body of `enqueue` for a BullMQ
 * producer (`queue.add(...)`) and move the actual work into a worker
 * process — no caller has to change.
 *
 * If BE-21's `ExportService` is unavailable for any reason (DI not
 * wired, optional dep missing, etc.) the queue still completes the
 * report row with `summary` + `rowCount` so the dashboard list view
 * renders correctly; only the artefact files are skipped.
 *
 * Errors on the generator path set the report's status to `failed`
 * and persist a redacted `errorMessage`.
 */
@Injectable()
export class ReportQueueService {
  constructor(
    private readonly reportsRepo: ReportsRepository,
    private readonly generator: ReportGeneratorService,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
    @Optional()
    @Inject(EXPORT_SERVICE)
    private readonly exporter?: IExportFacade,
  ) {}

  /**
   * Run the full pipeline for a report row that is in `pending`
   * status. Idempotent: re-running a `completed` row regenerates the
   * artefacts (the file repo upserts) but leaves the row status
   * untouched.
   */
  async enqueue(reportId: string): Promise<void> {
    const report = await this.reportsRepo.findById(reportId);
    if (!report) {
      throw new Error(`Report not found: ${reportId}`);
    }
    if (report.status === 'cancelled') {
      this.logger.warn('reports.queue.skip-cancelled', { reportId });
      return;
    }

    const startedAt = new Date();
    await this.reportsRepo.updateStatus(reportId, 'generating', {
      generationStartedAt: startedAt,
    });

    try {
      const params = report.parameters as unknown as GenerateReportParams;
      const data = await this.generator.run(report.type as ReportType, params, report.tenantId);

      const formats = (params.formats ?? ['json']) as Be21ReportFormat[];
      const exportOutcome = await this.exportFiles(report, params, data, formats);

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      await this.reportsRepo.updateStatus(reportId, 'completed', {
        generationCompletedAt: completedAt,
        generationDurationMs: durationMs,
        rowCount: data.rows.length,
        summary: data.summary,
        errorMessage: null,
      });

      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'Report',
        resourceId: reportId,
        userId: report.requestedBy,
        tenantId: report.tenantId,
        success: true,
        metadata: {
          transition: 'generated',
          type: report.type,
          formats,
          formatsBuilt: exportOutcome.builtFormats,
          formatsFailed: exportOutcome.failedFormats,
          totalSizeBytes: exportOutcome.totalSizeBytes,
          rowCount: data.rows.length,
          durationMs,
        },
      });

      this.logger.info('reports.queue.completed', {
        reportId,
        type: report.type,
        rowCount: data.rows.length,
        durationMs,
      });
    } catch (err) {
      const completedAt = new Date();
      const message = (err as Error).message?.slice(0, 1000) ?? 'unknown error';
      await this.reportsRepo.updateStatus(reportId, 'failed', {
        generationCompletedAt: completedAt,
        errorMessage: message,
      });
      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'Report',
        resourceId: reportId,
        userId: report.requestedBy,
        tenantId: report.tenantId,
        success: false,
        errorCode: (err as { code?: string }).code,
        metadata: { transition: 'failed', type: report.type, error: message },
      });
      this.logger.error('reports.queue.failed', {
        reportId,
        type: report.type,
        error: { name: (err as Error).name, message },
      });
      throw err;
    }
  }

  private async exportFiles(
    report: Awaited<ReturnType<ReportsRepository['findById']>> & object,
    params: GenerateReportParams,
    data: import('../types/report.types').ReportData,
    formats: Be21ReportFormat[],
  ): Promise<{
    builtFormats: Be21ReportFormat[];
    failedFormats: Be21ReportFormat[];
    totalSizeBytes: number;
  }> {
    if (!this.exporter) {
      this.logger.warn('reports.queue.export-skipped', {
        reportId: report.id,
        reason: 'EXPORT_SERVICE not bound',
      });
      return { builtFormats: [], failedFormats: formats, totalSizeBytes: 0 };
    }

    const options: Be21ExportOptions = {
      title: report.title,
      generatedAt: new Date(),
      generatedBy: report.requestedBy,
      tenantName: report.tenantId, // BE-21 will resolve to a friendlier display name when tenant rows land here
      dateRange: params.dateRange,
    };

    try {
      const result = await this.exporter.exportData(
        {
          reportId: report.id,
          tenantId: report.tenantId,
          formats,
          data,
          options,
        },
        report.requestedBy,
      );
      return {
        builtFormats: result.files.map((f) => f.format),
        failedFormats: formats.filter((f) => !result.files.some((built) => built.format === f)),
        totalSizeBytes: result.totalSizeBytes,
      };
    } catch (err) {
      this.logger.warn('reports.queue.export-failed', {
        reportId: report.id,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return { builtFormats: [], failedFormats: formats, totalSizeBytes: 0 };
    }
  }
}

/**
 * Default DI binding glue — wires the BE-21 `ExportService` to the
 * generic `EXPORT_SERVICE` token consumed by `ReportQueueService`.
 *
 * Kept here so the module file stays purely declarative. The
 * `IExportFacade` interface is the narrowest view BE-20 needs; if
 * BE-21's surface changes, this is the only seam to update.
 */
@Injectable()
export class DefaultExportFacade implements IExportFacade {
  constructor(private readonly exportService: ExportService) {}

  exportData = (
    request: Parameters<IExportFacade['exportData']>[0],
    userId: string,
  ): ReturnType<IExportFacade['exportData']> => this.exportService.exportData(request, userId);
}
