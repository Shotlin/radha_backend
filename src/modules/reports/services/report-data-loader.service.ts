import { Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';

import { ReportsRepository } from '../repositories/reports.repository';
import type { ExportOptions, ReportData, ReportDataLoader } from '../types/export.types';
import type { GenerateReportParams, ReportType } from '../types/report.types';

import { ReportGeneratorService } from './report-generator.service';

/**
 * BE-20 — `ReportDataLoader` implementation that BE-21's
 * `ExportService.exportReport(reportId, ...)` consumes.
 *
 * The loader replays the original `parameters` payload against the
 * generator dispatcher so a regenerated artefact is consistent with
 * the row's recorded `summary`. We deliberately do *not* read raw
 * data out of the report row — the row only stores aggregates; the
 * source of truth for export bytes is always a fresh generator run.
 *
 * Wired into BE-21 via the `REPORT_DATA_LOADER` token in
 * `ReportsModule`.
 */
@Injectable()
export class ReportDataLoaderService implements ReportDataLoader {
  constructor(
    private readonly reportsRepo: ReportsRepository,
    private readonly generator: ReportGeneratorService,
  ) {}

  async load(
    reportId: string,
    tenantId: string,
  ): Promise<{ data: ReportData; options: ExportOptions }> {
    const report = await this.reportsRepo.findByIdInTenant(reportId, tenantId);
    if (!report) throw new DomainNotFoundException('Report', reportId);

    const params = report.parameters as unknown as GenerateReportParams;
    const generated = await this.generator.run(report.type as ReportType, params, tenantId);

    const data: ReportData = {
      summary: generated.summary,
      rows: generated.rows as Record<string, unknown>[],
    };
    const options: ExportOptions = {
      title: report.title,
      generatedAt: new Date(),
      generatedBy: report.requestedBy,
      tenantName: tenantId,
      dateRange: params.dateRange,
    };
    return { data, options };
  }
}
