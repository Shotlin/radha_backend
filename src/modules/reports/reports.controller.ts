import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import {
  AdHocExportBodyDto,
  AdHocExportBodySchema,
  DownloadByFormatParamSchema,
  DownloadQueryDto,
  DownloadQuerySchema,
  ExportExistingReportBodyDto,
  ExportExistingReportBodySchema,
} from './dto/reports.dto';
import { ExportService } from './exporters/export.service';
import { ReportFilesRepository } from './repositories/report-files.repository';
import { ReportDownloadService } from './services/report-download.service';
import type { ExportRequest, ReportFormat } from './types/export.types';

/**
 * BE-21 — Reports / Export REST surface.
 *
 *   POST /api/v1/reports/export                     — ad-hoc export
 *   POST /api/v1/reports/:id/export                 — re-export BE-20 report
 *   GET  /api/v1/reports/:id/files                  — list artefacts
 *   GET  /api/v1/reports/:id/download/:format       — presigned URL
 *   GET  /api/v1/report-files/:id/download          — presigned URL by file id
 *
 * BE-08 guard stack on every route. Permissions:
 *   - reads  → `reports:export` (BE-08 already grants this to
 *               owner / admin / manager / staff / auditor where
 *               applicable).
 *   - writes → `reports:export` as well — generation itself is
 *               BE-20's `reports:generate`.
 *
 * Tenant scope is mandatory.
 *
 * Static segments are declared before `:id` routes so Nest's path
 * resolver doesn't accidentally route `/files` into the dynamic
 * `:id/files` slot.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class ReportsController {
  constructor(
    private readonly exportService: ExportService,
    private readonly download: ReportDownloadService,
    private readonly filesRepo: ReportFilesRepository,
  ) {}

  /* ─────────────────── Ad-hoc export ─────────────────── */

  @Post('reports/export')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:export')
  @RequireTenant()
  async exportAdHoc(
    @Body(new ZodValidationPipe(AdHocExportBodySchema)) dto: AdHocExportBodyDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    // Ad-hoc exports get a synthetic report id so the artefact rows
    // can still cluster in `report_files`. The id is opaque to the
    // caller and returned in the response.
    const reportId = this.mintAdHocReportId();

    const request: ExportRequest = {
      reportId,
      tenantId,
      formats: dto.formats,
      data: { rows: dto.rows, summary: dto.summary },
      options: {
        title: dto.title,
        subtitle: dto.subtitle,
        generatedAt: new Date(),
        generatedBy: userId,
        tenantName: dto.tenantName,
        storeName: dto.storeName,
        dateRange: dto.dateFrom && dto.dateTo ? { from: dto.dateFrom, to: dto.dateTo } : undefined,
      },
      retentionDays: dto.retentionDays,
    };

    return this.exportService.exportData(request, userId);
  }

  /* ─────────────────── Existing report export ─────────────────── */

  @Post('reports/:id/export')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:export')
  @RequireTenant()
  exportExisting(
    @Param('id', new ParseUuidPipe()) reportId: string,
    @Body(new ZodValidationPipe(ExportExistingReportBodySchema))
    dto: ExportExistingReportBodyDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.exportService.exportReport(reportId, tenantId, dto.formats, userId);
  }

  /* ─────────────────── Listing ─────────────────── */

  @Get('reports/:id/files')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('reports:export')
  @RequireTenant()
  listFiles(
    @Param('id', new ParseUuidPipe()) reportId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.filesRepo.listForReport(reportId, tenantId);
  }

  /* ─────────────────── Downloads ─────────────────── */

  @Get('reports/:id/download/:format')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('reports:export')
  @RequireTenant()
  downloadByFormat(
    @Param('id', new ParseUuidPipe()) reportId: string,
    @Param('format', new ZodValidationPipe(DownloadByFormatParamSchema.shape.format))
    format: ReportFormat,
    @Query(new ZodValidationPipe(DownloadQuerySchema)) query: DownloadQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.download.getDownloadUrlByFormat(reportId, tenantId, format, query.expirySeconds);
  }

  @Get('report-files/:id/download')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('reports:export')
  @RequireTenant()
  downloadById(
    @Param('id', new ParseUuidPipe()) fileId: string,
    @Query(new ZodValidationPipe(DownloadQuerySchema)) query: DownloadQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.download.getDownloadUrl(fileId, tenantId, query.expirySeconds);
  }

  /* ─────────────────── helpers ─────────────────── */

  private mintAdHocReportId(): string {
    return randomUUID();
  }
}
