import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
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
  AcknowledgeAlertDto,
  AcknowledgeAlertSchema,
  CreateExpiryRecordDto,
  CreateExpiryRecordSchema,
  ExpiryStatsQueryDto,
  ExpiryStatsQuerySchema,
  ForecastQueryDto,
  ForecastQuerySchema,
  ListAlertsQueryDto,
  ListAlertsQuerySchema,
  ListExpiryRecordsQueryDto,
  ListExpiryRecordsQuerySchema,
  ListThresholdsQueryDto,
  ListThresholdsQuerySchema,
  NearExpiryQueryDto,
  NearExpiryQuerySchema,
  OcrValidateBodyDto,
  OcrValidateBodySchema,
  RecalculateBodyDto,
  RecalculateBodySchema,
  ResolveAlertDto,
  ResolveAlertSchema,
  SetThresholdDto,
  SetThresholdSchema,
} from './dto/expiry.dto';
import { ExpiryService } from './expiry.service';
import { ExpiryAlertService } from './services/expiry-alert.service';
import { ExpiryAlertsRepository } from './repositories/expiry-alerts.repository';
import { ExpiryThresholdService } from './services/expiry-threshold.service';
import { OcrDateValidatorService } from './services/ocr-date-validator.service';

/**
 * BE-18 — Expiry tracking REST surface.
 *
 *   /api/v1/expiry-records/...     records + stats + forecast + recalculate
 *   /api/v1/expiry-thresholds/...  per-tenant thresholds
 *   /api/v1/expiry-alerts/...      alert lifecycle
 *
 * All endpoints behind the BE-08 guard stack. Permissions:
 *   - reads:  `inventory:read` (proxy for "store-level operational data")
 *   - writes: `inventory:write`
 *
 * Tenant scoping is mandatory — every route is `@RequireTenant()`.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class ExpiryController {
  constructor(
    private readonly expiry: ExpiryService,
    private readonly alerts: ExpiryAlertService,
    private readonly alertsRepo: ExpiryAlertsRepository,
    private readonly thresholds: ExpiryThresholdService,
    private readonly ocr: OcrDateValidatorService,
  ) {}

  /* ─────────────────── Records ─────────────────── */

  @Post('expiry-records')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  create(
    @Body(new ZodValidationPipe(CreateExpiryRecordSchema)) dto: CreateExpiryRecordDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.expiry.createRecord(tenantId, userId, dto);
  }

  @Get('expiry-records/near-expiry')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  nearExpiry(
    @Query(new ZodValidationPipe(NearExpiryQuerySchema)) query: NearExpiryQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.expiry.findNearExpiry(tenantId, query.storeId, query.daysAhead);
  }

  @Get('expiry-records/expired')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  expired(
    @Query(new ZodValidationPipe(ExpiryStatsQuerySchema)) query: ExpiryStatsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.expiry.findExpired(tenantId, query.storeId);
  }

  @Get('expiry-records/forecast')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  forecast(
    @Query(new ZodValidationPipe(ForecastQuerySchema)) query: ForecastQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.expiry.forecast(tenantId, query.storeId, query.daysAhead);
  }

  @Get('expiry-records/stats')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  stats(
    @Query(new ZodValidationPipe(ExpiryStatsQuerySchema)) query: ExpiryStatsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.expiry.getStoreStats(tenantId, query.storeId);
  }

  @Get('expiry-records/stats/by-category')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  statsByCategory(
    @Query(new ZodValidationPipe(ExpiryStatsQuerySchema)) query: ExpiryStatsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.expiry.getCategoryStats(tenantId, query.storeId);
  }

  @Post('expiry-records/recalculate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  recalculate(
    @Body(new ZodValidationPipe(RecalculateBodySchema)) body: RecalculateBodyDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.expiry.recalculateForStore(tenantId, userId, body.storeId);
  }

  @Get('expiry-records/:id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  getOne(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.expiry.findById(tenantId, id);
  }

  @Get('expiry-records')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListExpiryRecordsQuerySchema)) query: ListExpiryRecordsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.expiry.list(tenantId, query);
  }

  /* ─────────────────── Thresholds ─────────────────── */

  @Get('expiry-thresholds')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  listThresholds(
    @Query(new ZodValidationPipe(ListThresholdsQuerySchema)) query: ListThresholdsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.thresholds.listForTenant(tenantId, query.category);
  }

  @Put('expiry-thresholds')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  upsertThreshold(
    @Body(new ZodValidationPipe(SetThresholdSchema)) dto: SetThresholdDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.thresholds.upsertForTenant(tenantId, userId, dto);
  }

  /* ─────────────────── Alerts ─────────────────── */

  @Get('expiry-alerts')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  listAlerts(
    @Query(new ZodValidationPipe(ListAlertsQuerySchema)) query: ListAlertsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.alertsRepo.listForStore(tenantId, query.storeId, {
      acknowledged: query.acknowledged,
      resolved: query.resolved,
      limit: query.limit,
    });
  }

  @Post('expiry-alerts/:id/acknowledge')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  acknowledge(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(AcknowledgeAlertSchema)) dto: AcknowledgeAlertDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.alerts.acknowledge(tenantId, userId, id, dto.notes);
  }

  @Post('expiry-alerts/:id/resolve')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  resolve(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(ResolveAlertSchema)) dto: ResolveAlertDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.alerts.resolve(tenantId, userId, id, dto.resolution, dto.notes);
  }

  /* ─────────────────── OCR ─────────────────── */

  @Post('expiry/ocr/validate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  validateOcr(
    @Body(new ZodValidationPipe(OcrValidateBodySchema)) dto: OcrValidateBodyDto,
  ): unknown {
    return this.ocr.validate(dto.text, dto.confidence);
  }
}
