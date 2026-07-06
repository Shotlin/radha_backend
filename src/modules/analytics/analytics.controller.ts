import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
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
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import { ListLeadsQuerySchema, type ListLeadsQueryDto } from './dto/list-leads.dto';
import {
  TrackAppEventBatchSchema,
  TrackAppEventSchema,
  type TrackAppEventBatchDto,
  type TrackAppEventDto,
} from './dto/track-app-event.dto';
import {
  ConvertLeadSchema,
  UpdateLeadSchema,
  type ConvertLeadDto,
  type UpdateLeadDto,
} from './dto/update-lead.dto';
import { WebsiteStatsQuerySchema, type WebsiteStatsQueryDto } from './dto/website-stats-query.dto';
import { AppAnalyticsService } from './services/app-analytics.service';
import { FunnelService } from './services/funnel.service';
import { LeadsService } from './services/leads.service';
import { WebsiteAnalyticsService } from './services/website-analytics.service';
import { parseDateRange } from './utils/date-range.util';

/**
 * BE-29 — Authenticated analytics + lead-management surface.
 *
 * Endpoints:
 *
 *   POST   /api/v1/analytics/app/events              — track one
 *   POST   /api/v1/analytics/app/events/batch        — track up to 100
 *   GET    /api/v1/analytics/app/me                  — current user activity
 *   GET    /api/v1/analytics/app/tenant              — tenant-wide activity
 *   GET    /api/v1/analytics/website/stats           — owner-only
 *   GET    /api/v1/analytics/website/funnel          — owner-only
 *   GET    /api/v1/analytics/funnel                  — owner-only (full)
 *   GET    /api/v1/marketing/leads                   — owner/admin
 *   GET    /api/v1/marketing/leads/:id               — owner/admin
 *   PATCH  /api/v1/marketing/leads/:id               — owner/admin
 *   POST   /api/v1/marketing/leads/:id/convert       — owner/admin
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class AnalyticsController {
  constructor(
    private readonly websiteAnalytics: WebsiteAnalyticsService,
    private readonly appAnalytics: AppAnalyticsService,
    private readonly leads: LeadsService,
    private readonly funnel: FunnelService,
  ) {}

  /* ────────── App events (tenant-scoped) ────────── */

  @Post('analytics/app/events')
  @Version('1')
  @HttpCode(202)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  async trackAppEvent(
    @Body(new ZodValidationPipe(TrackAppEventSchema)) dto: TrackAppEventDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ accepted: true }> {
    await this.appAnalytics.trackEvent(dto, userId, tenantId);
    return { accepted: true };
  }

  @Post('analytics/app/events/batch')
  @Version('1')
  @HttpCode(202)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  async trackAppEventBatch(
    @Body(new ZodValidationPipe(TrackAppEventBatchSchema)) dto: TrackAppEventBatchDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ accepted: number }> {
    return this.appAnalytics.trackBatch(dto.events, userId, tenantId);
  }

  @Get('analytics/app/me')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  async getMyActivity(
    @Query(new ZodValidationPipe(WebsiteStatsQuerySchema)) query: WebsiteStatsQueryDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.appAnalytics.getUserActivity(
      userId,
      tenantId,
      parseDateRange(query.from, query.to),
    );
  }

  @Get('analytics/app/tenant')
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequireTenant()
  async getTenantActivity(
    @Query(new ZodValidationPipe(WebsiteStatsQuerySchema)) query: WebsiteStatsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.appAnalytics.getTenantActivity(tenantId, parseDateRange(query.from, query.to));
  }

  /* ────────── Website analytics (owner / admin) ────────── */

  @Get('analytics/website/stats')
  @Version('1')
  @Roles('owner', 'admin')
  async getWebsiteStats(
    @Query(new ZodValidationPipe(WebsiteStatsQuerySchema)) query: WebsiteStatsQueryDto,
  ): Promise<unknown> {
    return this.websiteAnalytics.getStats(parseDateRange(query.from, query.to));
  }

  @Get('analytics/website/funnel')
  @Version('1')
  @Roles('owner', 'admin')
  async getWebsiteFunnel(
    @Query(new ZodValidationPipe(WebsiteStatsQuerySchema)) query: WebsiteStatsQueryDto,
  ): Promise<unknown> {
    return this.websiteAnalytics.getFunnel(parseDateRange(query.from, query.to));
  }

  @Get('analytics/funnel')
  @Version('1')
  @Roles('owner', 'admin')
  async getFunnel(
    @Query(new ZodValidationPipe(WebsiteStatsQuerySchema)) query: WebsiteStatsQueryDto,
  ): Promise<unknown> {
    return this.funnel.getFullFunnel(parseDateRange(query.from, query.to));
  }

  /* ────────── Leads (owner / admin) ────────── */

  @Get('marketing/leads')
  @Version('1')
  @Roles('owner', 'admin')
  async listLeads(
    @Query(new ZodValidationPipe(ListLeadsQuerySchema)) query: ListLeadsQueryDto,
  ): Promise<unknown> {
    return this.leads.list(query);
  }

  @Get('marketing/leads/:id')
  @Version('1')
  @Roles('owner', 'admin')
  async getLead(@Param('id', new ParseUuidPipe()) id: string): Promise<unknown> {
    return this.leads.findById(id);
  }

  @Patch('marketing/leads/:id')
  @Version('1')
  @Roles('owner', 'admin')
  async updateLead(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateLeadSchema)) dto: UpdateLeadDto,
    @CurrentUser('id') actorUserId: string,
  ): Promise<unknown> {
    return this.leads.updateStatus(id, dto.status, dto.notes, actorUserId);
  }

  @Post('marketing/leads/:id/convert')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'admin')
  async convertLead(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(ConvertLeadSchema)) dto: ConvertLeadDto,
    @CurrentUser('id') actorUserId: string,
  ): Promise<unknown> {
    return this.leads.convert(id, dto.tenantId, actorUserId);
  }
}
