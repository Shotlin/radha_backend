import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

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
  AggregateMetricsBodyDto,
  AggregateMetricsBodySchema,
  DashboardQueryDto,
  DashboardQuerySchema,
  GenerateReportDto,
  GenerateReportSchema,
  ListReportsQueryDto,
  ListReportsQuerySchema,
  ScheduleReportDto,
  ScheduleReportSchema,
} from './dto/reports.dto';
import { ReportsService } from './reports.service';
import { MetricsAggregatorService } from './services/metrics-aggregator.service';
import { ReportScheduleService } from './services/report-schedule.service';
import type { GenerateReportParams, ScheduleReportParams } from './types/report.types';

/**
 * BE-20 — Generation / dashboard / schedule REST surface.
 *
 * BE-21's `ReportsController` already covers
 *   - POST `/api/v1/reports/export`
 *   - POST `/api/v1/reports/:id/export`
 *   - GET  `/api/v1/reports/:id/files`
 *   - GET  `/api/v1/reports/:id/download/:format`
 *   - GET  `/api/v1/report-files/:id/download`
 *
 * This controller adds the BE-20 surface that complements it:
 *   - GET  `/api/v1/dashboard/summary`
 *   - POST `/api/v1/reports/generate`
 *   - GET  `/api/v1/reports`
 *   - GET  `/api/v1/reports/:id`
 *   - POST `/api/v1/reports/:id/cancel`
 *   - POST `/api/v1/reports/aggregate`
 *   - POST `/api/v1/reports/schedule`
 *   - GET  `/api/v1/reports/scheduled`
 *   - GET  `/api/v1/reports/scheduled/:id`
 *   - POST `/api/v1/reports/scheduled/:id/{pause|resume}`
 *   - DELETE `/api/v1/reports/scheduled/:id`
 *
 * BE-08 guard stack runs on every route. Static segments are
 * declared before the dynamic `:id` route so Nest's path resolver
 * never sends `aggregate` / `scheduled` / `schedule` into the
 * `:id` slot.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class ReportGenerationController {
  constructor(
    private readonly reports: ReportsService,
    private readonly schedules: ReportScheduleService,
    private readonly aggregator: MetricsAggregatorService,
  ) {}

  /* ─────────────────── Dashboard (live) ─────────────────── */

  @Get('dashboard/summary')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('reports:read')
  @RequireTenant()
  dashboard(
    @Query(new ZodValidationPipe(DashboardQuerySchema as never))
    query: DashboardQueryDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.reports.getDashboardSummary(tenantId, userId, query.storeId, {
      from: query.from,
      to: query.to,
    });
  }

  /* ─────────────────── Reports — static routes first ─────────────────── */

  @Post('reports/generate')
  @Version('1')
  @HttpCode(202)
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  generate(
    @Body(new ZodValidationPipe(GenerateReportSchema)) dto: GenerateReportDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    const params: GenerateReportParams = {
      type: dto.type,
      formats: dto.formats,
      storeIds: dto.storeIds,
      dateRange: dto.dateRange,
      filters: dto.filters,
      groupBy: dto.groupBy,
      includeCharts: dto.includeCharts,
      title: dto.title,
    };
    return this.reports.generate(tenantId, userId, params);
  }

  @Post('reports/aggregate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  aggregate(
    @Body(new ZodValidationPipe(AggregateMetricsBodySchema))
    body: AggregateMetricsBodyDto,
  ): Promise<unknown> {
    return this.aggregator.aggregateForDate(body.date);
  }

  @Post('reports/schedule')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  scheduleCreate(
    @Body(new ZodValidationPipe(ScheduleReportSchema)) dto: ScheduleReportDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    const params: ScheduleReportParams = {
      type: dto.type,
      title: dto.title,
      storeId: dto.storeId,
      frequency: dto.frequency,
      dayOfWeek: dto.dayOfWeek,
      dayOfMonth: dto.dayOfMonth,
      hourOfDay: dto.hourOfDay,
      parameters: {
        type: dto.parameters.type,
        formats: dto.parameters.formats,
        storeIds: dto.parameters.storeIds,
        dateRange: dto.parameters.dateRange,
        filters: dto.parameters.filters,
        groupBy: dto.parameters.groupBy,
        includeCharts: dto.parameters.includeCharts,
        title: dto.parameters.title,
      },
      recipients: dto.recipients,
    };
    return this.schedules.create(tenantId, userId, params);
  }

  @Get('reports/scheduled')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('reports:read')
  @RequireTenant()
  scheduleList(@CurrentTenant() tenantId: string): Promise<unknown> {
    return this.schedules.list(tenantId);
  }

  @Get('reports/scheduled/:id')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('reports:read')
  @RequireTenant()
  scheduleGet(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.schedules.findById(tenantId, id);
  }

  @Post('reports/scheduled/:id/pause')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  schedulePause(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.schedules.pause(tenantId, userId, id);
  }

  @Post('reports/scheduled/:id/resume')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  scheduleResume(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.schedules.resume(tenantId, userId, id);
  }

  @Delete('reports/scheduled/:id')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  scheduleCancel(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.schedules.cancel(tenantId, userId, id);
  }

  /* ─────────────────── Reports — list + per-id ─────────────────── */

  @Get('reports')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('reports:read')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListReportsQuerySchema)) query: ListReportsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.reports.list(tenantId, query);
  }

  @Post('reports/:id/cancel')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  cancel(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.reports.cancel(tenantId, userId, id);
  }

  @Get('reports/:id')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('reports:read')
  @RequireTenant()
  get(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.reports.findById(tenantId, id);
  }
}
