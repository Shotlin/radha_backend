import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainNotFoundException,
  ValidationException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { DashboardSummaryGenerator } from './generators/dashboard-summary.generator';
import { ReportFilesRepository } from './repositories/report-files.repository';
import { ReportsRepository } from './repositories/reports.repository';
import { ReportGeneratorService } from './services/report-generator.service';
import { ReportQueueService } from './services/report-queue.service';
import type {
  DashboardSummary,
  DateRange,
  GenerateReportParams,
  ListReportsFilters,
  Report,
  ReportData,
  ReportFile,
  ReportFormat,
  ReportGenerationResult,
  ReportSummary,
  ReportType,
  ReportWithFiles,
} from './types/report.types';
import { estimateDurationSeconds } from './utils/schedule.utils';

const DEFAULT_RETENTION_DAYS = 90;

/**
 * BE-20 — Top-level facade for the Reports module.
 *
 * The controller calls into here; everything else is internal. This
 * is also the seam BE-21 plugs into for download URLs and BE-24 for
 * scheduled fan-outs.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly reportsRepo: ReportsRepository,
    private readonly filesRepo: ReportFilesRepository,
    private readonly generator: ReportGeneratorService,
    private readonly queue: ReportQueueService,
    private readonly dashboard: DashboardSummaryGenerator,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
  ) {}

  /* ─────────────────── Generation ─────────────────── */

  async generate(
    tenantId: string,
    userId: string,
    params: GenerateReportParams,
  ): Promise<ReportGenerationResult> {
    if (!this.generator.has(params.type)) {
      throw new ValidationException(`Unknown report type: ${params.type}`);
    }
    if (params.type === 'dashboard') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        "Dashboard summaries are served live via /api/v1/dashboard/summary; don't queue them.",
      );
    }

    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + DEFAULT_RETENTION_DAYS);

    const report = await this.reportsRepo.create({
      tenantId,
      storeId: params.storeIds && params.storeIds.length === 1 ? params.storeIds[0] : null,
      type: params.type,
      title: this.buildTitle(params),
      status: 'pending',
      parameters: params as unknown as Record<string, unknown>,
      dateFrom: params.dateRange.from,
      dateTo: params.dateRange.to,
      requestedBy: userId,
      expiresAt,
      createdBy: userId,
    });

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'Report',
      resourceId: report.id,
      userId,
      tenantId,
      success: true,
      metadata: {
        transition: 'queued',
        type: params.type,
        formats: params.formats,
        storeIds: params.storeIds ?? [],
      },
    });

    // v1 — sync-mode-with-queue-shaped-API. BE-24 will swap this for
    // a BullMQ producer call.
    try {
      await this.queue.enqueue(report.id);
    } catch (err) {
      this.logger.error('reports.service.queue-failed', {
        reportId: report.id,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      // queue.enqueue persists `failed` status itself; rethrow so the
      // caller sees the error envelope.
      throw err;
    }

    const finalReport = await this.reportsRepo.findById(report.id);
    return {
      reportId: report.id,
      status: finalReport?.status ?? 'pending',
      estimatedDurationSeconds: estimateDurationSeconds(
        params.dateRange.from.getTime(),
        params.dateRange.to.getTime(),
        params.formats.length,
      ),
      formats: params.formats,
    };
  }

  async findById(tenantId: string, id: string): Promise<ReportWithFiles> {
    const row = await this.reportsRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('Report', id);
    const files = await this.filesRepo.listForReport(id, tenantId);
    return { ...row, files };
  }

  async getStatus(tenantId: string, id: string): Promise<ReportSummary> {
    const row = await this.reportsRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('Report', id);
    return {
      reportId: row.id,
      status: row.status,
      type: row.type,
      title: row.title,
      rowCount: row.rowCount,
      summary: (row.summary as Record<string, unknown>) ?? {},
      errorMessage: row.errorMessage,
      durationMs: row.generationDurationMs,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  async list(tenantId: string, filters: ListReportsFilters): Promise<ReportSummary[]> {
    const rows = await this.reportsRepo.listForTenant(tenantId, filters);
    return rows.map((row) => ({
      reportId: row.id,
      status: row.status,
      type: row.type,
      title: row.title,
      rowCount: row.rowCount,
      summary: (row.summary as Record<string, unknown>) ?? {},
      errorMessage: row.errorMessage,
      durationMs: row.generationDurationMs,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    }));
  }

  /* ─────────────────── Download metadata ─────────────────── */

  async getDownloadInfo(
    tenantId: string,
    userId: string,
    reportId: string,
    format: ReportFormat,
  ): Promise<ReportFile> {
    const report = await this.reportsRepo.findByIdInTenant(reportId, tenantId);
    if (!report) throw new DomainNotFoundException('Report', reportId);
    if (report.status !== 'completed') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Report is in status ${report.status}; cannot download yet.`,
      );
    }
    const file = await this.filesRepo.findByReportFormat(reportId, tenantId, format);
    if (!file) {
      throw new DomainNotFoundException(`ReportFile(${format})`, reportId);
    }

    await this.audit.logAction({
      action: 'EXPORT',
      resourceType: 'Report',
      resourceId: reportId,
      userId,
      tenantId,
      success: true,
      metadata: { format, fileName: file.fileName },
    });
    return file;
  }

  /* ─────────────────── Live dashboard ─────────────────── */

  async getDashboardSummary(
    tenantId: string,
    userId: string,
    storeId: string,
    dateRange: DateRange,
  ): Promise<DashboardSummary> {
    const summary = await this.dashboard.summarise(tenantId, storeId, dateRange);
    await this.audit.logAction({
      action: 'READ',
      resourceType: 'DashboardSummary',
      resourceId: storeId,
      userId,
      tenantId,
      success: true,
      metadata: {
        from: dateRange.from.toISOString(),
        to: dateRange.to.toISOString(),
      },
    });
    return summary;
  }

  /* ─────────────────── Internal helpers ─────────────────── */

  /**
   * Re-run a report — used by BE-24 cron when a schedule fires. The
   * input is the same payload the human originally supplied, so the
   * audit trail stays meaningful.
   */
  async runFromSchedule(
    tenantId: string,
    userId: string,
    scheduleId: string,
    params: GenerateReportParams,
  ): Promise<Report> {
    const result = await this.generate(tenantId, userId, params);
    const report = await this.reportsRepo.findById(result.reportId);
    if (report && report.scheduleId !== scheduleId) {
      await this.reportsRepo.update(report.id, { scheduleId });
    }
    return (report ?? (await this.reportsRepo.findById(result.reportId))) as Report;
  }

  async cancel(tenantId: string, userId: string, id: string): Promise<Report> {
    const existing = await this.reportsRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('Report', id);
    if (existing.status === 'completed' || existing.status === 'failed') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Report is in status ${existing.status}; cannot cancel`,
      );
    }
    const updated = await this.reportsRepo.update(id, {
      status: 'cancelled',
      updatedBy: userId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'Report',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'cancel' },
    });
    return updated;
  }

  /**
   * Synchronous helper used by tests and by future inline-call
   * paths. Returns the raw `ReportData` without persisting anything.
   */
  async preview(
    tenantId: string,
    type: ReportType,
    params: GenerateReportParams,
  ): Promise<ReportData> {
    return this.generator.run(type, params, tenantId);
  }

  private buildTitle(params: GenerateReportParams): string {
    if (params.title) return params.title;
    const from = params.dateRange.from.toISOString().slice(0, 10);
    const to = params.dateRange.to.toISOString().slice(0, 10);
    return `${params.type} (${from} → ${to})`;
  }
}
