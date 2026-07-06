import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { EanListsModule } from '@/modules/ean-lists/ean-lists.module';
import { ExpiryModule } from '@/modules/expiry/expiry.module';
import { ProductsModule } from '@/modules/products/products.module';
import { ScansModule } from '@/modules/scans/scans.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { CsvExporterService } from './exporters/csv-exporter.service';
import { ExcelExporterService } from './exporters/excel-exporter.service';
import { ExportService } from './exporters/export.service';
import { PdfExporterService } from './exporters/pdf-exporter.service';
import { AuditTrailGenerator } from './generators/audit-trail.generator';
import { DashboardSummaryGenerator } from './generators/dashboard-summary.generator';
import { EanMismatchGenerator } from './generators/ean-mismatch.generator';
import { ExpirySummaryGenerator } from './generators/expiry-summary.generator';
import { GrnHistoryGenerator } from './generators/grn-history.generator';
import { HealthDistributionGenerator } from './generators/health-distribution.generator';
import { InventorySummaryGenerator } from './generators/inventory-summary.generator';
import { ScanHistoryGenerator } from './generators/scan-history.generator';
import { TaskCompletionGenerator } from './generators/task-completion.generator';
import { DailyStoreMetricsRepository } from './repositories/daily-store-metrics.repository';
import { ReportFilesRepository } from './repositories/report-files.repository';
import { ReportSchedulesRepository } from './repositories/report-schedules.repository';
import { ReportsRepository } from './repositories/reports.repository';
import { ReportGenerationController } from './reports-generation.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { MetricsAggregatorService } from './services/metrics-aggregator.service';
import { ReportDataLoaderService } from './services/report-data-loader.service';
import { ReportDownloadService } from './services/report-download.service';
import { ReportGeneratorService } from './services/report-generator.service';
import { DefaultExportFacade, ReportQueueService } from './services/report-queue.service';
import { ReportScheduleService } from './services/report-schedule.service';
import { ReportStorageService } from './services/report-storage.service';
import { REPORT_DATA_LOADER } from './types/export.types';
import { EXPORT_SERVICE } from './types/queue.types';

/**
 * BE-20 + BE-21 — Reports module.
 *
 * Two phases live in one Nest module because they share the same
 * `report_files` row, the same DI scope, and the same controller
 * mount path. The controllers are split for cohesion:
 *
 *   - `ReportsController`            → BE-21 export + download
 *     (`POST reports/export`, `POST reports/:id/export`,
 *      `GET reports/:id/files`,
 *      `GET reports/:id/download/:format`,
 *      `GET report-files/:id/download`).
 *   - `ReportGenerationController`   → BE-20 generation, listing,
 *     schedules, aggregator, dashboard.
 *
 * Imports:
 *   - `AuthModule`         → BE-08 guard stack + decorators.
 *   - `ObservabilityModule` → AuditLogService.
 *   - `ScansModule`         → consumed by generators (raw-SQL today;
 *                             keeps the DI graph honest for future
 *                             service-level cross-calls).
 *   - `ExpiryModule`        → records / alerts already exported.
 *   - `EanListsModule`      → ean-list activation context.
 *   - `ProductsModule`      → product lookups for joins.
 *   - `AwsModule` (global)  → S3_SERVICE_TOKEN.
 *
 * BE-20 ↔ BE-21 wiring:
 *   - `EXPORT_SERVICE`       — token consumed by `ReportQueueService`.
 *                              Bound to `DefaultExportFacade` which
 *                              delegates to BE-21's `ExportService`.
 *   - `REPORT_DATA_LOADER`   — BE-20 binds `ReportDataLoaderService`
 *                              so BE-21's `exportReport(reportId)` can
 *                              regenerate data on demand.
 */
@Module({
  imports: [
    AuthModule,
    ObservabilityModule,
    ScansModule,
    ExpiryModule,
    EanListsModule,
    ProductsModule,
  ],
  controllers: [ReportsController, ReportGenerationController],
  providers: [
    /* BE-21 — exporters + download surface */
    ExcelExporterService,
    PdfExporterService,
    CsvExporterService,
    ReportStorageService,
    ReportDownloadService,
    ExportService,

    /* BE-20 — repositories */
    ReportsRepository,
    ReportFilesRepository,
    ReportSchedulesRepository,
    DailyStoreMetricsRepository,

    /* BE-20 — generators */
    ExpirySummaryGenerator,
    EanMismatchGenerator,
    ScanHistoryGenerator,
    TaskCompletionGenerator,
    DashboardSummaryGenerator,
    AuditTrailGenerator,
    HealthDistributionGenerator,
    InventorySummaryGenerator,
    GrnHistoryGenerator,

    /* BE-20 — services */
    ReportGeneratorService,
    ReportQueueService,
    ReportScheduleService,
    MetricsAggregatorService,
    ReportsService,
    ReportDataLoaderService,
    DefaultExportFacade,

    /* Cross-phase DI bindings */
    {
      provide: EXPORT_SERVICE,
      useExisting: DefaultExportFacade,
    },
    {
      provide: REPORT_DATA_LOADER,
      useExisting: ReportDataLoaderService,
    },
  ],
  exports: [
    /* BE-21 surface */
    ExportService,
    ReportDownloadService,
    ReportStorageService,
    ReportFilesRepository,
    ExcelExporterService,
    PdfExporterService,
    CsvExporterService,

    /* BE-20 surface */
    ReportsService,
    ReportScheduleService,
    MetricsAggregatorService,
    ReportGeneratorService,
    ReportsRepository,
    ReportSchedulesRepository,
    DailyStoreMetricsRepository,
  ],
})
export class ReportsModule {}
