import { Injectable } from '@nestjs/common';

import { ValidationException } from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';

import { AuditTrailGenerator } from '../generators/audit-trail.generator';
import { DashboardSummaryGenerator } from '../generators/dashboard-summary.generator';
import { EanMismatchGenerator } from '../generators/ean-mismatch.generator';
import { ExpirySummaryGenerator } from '../generators/expiry-summary.generator';
import { GrnHistoryGenerator } from '../generators/grn-history.generator';
import { HealthDistributionGenerator } from '../generators/health-distribution.generator';
import { InventorySummaryGenerator } from '../generators/inventory-summary.generator';
import { ScanHistoryGenerator } from '../generators/scan-history.generator';
import { TaskCompletionGenerator } from '../generators/task-completion.generator';
import type {
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

/**
 * BE-20 — Generator dispatcher.
 *
 * Holds a `Map<ReportType, IReportGenerator>` so concrete generators
 * stay independently testable. Throws a typed `ValidationException`
 * if the caller asks for an unknown type — the controller surfaces
 * this as a 400 with the usual error envelope.
 */
@Injectable()
export class ReportGeneratorService {
  private readonly generators: Map<ReportType, IReportGenerator> = new Map();

  constructor(
    private readonly logger: LoggerService,
    expiry: ExpirySummaryGenerator,
    eanMismatch: EanMismatchGenerator,
    scanHistory: ScanHistoryGenerator,
    taskCompletion: TaskCompletionGenerator,
    dashboard: DashboardSummaryGenerator,
    auditTrail: AuditTrailGenerator,
    healthDistribution: HealthDistributionGenerator,
    inventorySummary: InventorySummaryGenerator,
    grnHistory: GrnHistoryGenerator,
  ) {
    const all: IReportGenerator[] = [
      expiry,
      eanMismatch,
      scanHistory,
      taskCompletion,
      dashboard,
      auditTrail,
      healthDistribution,
      inventorySummary,
      grnHistory,
    ];
    for (const g of all) {
      this.generators.set(g.type, g);
    }
  }

  has(type: ReportType): boolean {
    return this.generators.has(type);
  }

  supportedTypes(): ReportType[] {
    return [...this.generators.keys()];
  }

  async run(type: ReportType, params: GenerateReportParams, tenantId: string): Promise<ReportData> {
    const generator = this.generators.get(type);
    if (!generator) {
      throw new ValidationException(`Unknown report type: ${type}`);
    }
    const start = Date.now();
    try {
      const data = await generator.generate(params, tenantId);
      this.logger.info('reports.generator.completed', {
        type,
        tenantId,
        rows: data.rows.length,
        durationMs: Date.now() - start,
      });
      return data;
    } catch (err) {
      this.logger.error('reports.generator.failed', {
        type,
        tenantId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      throw err;
    }
  }
}
