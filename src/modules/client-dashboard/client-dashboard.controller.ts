import { Controller, Get, Query, UseGuards, Version } from '@nestjs/common';

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
import { RequireStore, StoreScopeGuard } from '@/modules/stores/guards/store-scope.guard';

import {
  ActivityQuerySchema,
  AlertsQuerySchema,
  DashboardQuerySchema,
  HealthScoreQuerySchema,
  KpisQuerySchema,
  QuickActionsQuerySchema,
  TeamQuerySchema,
  TrendsQuerySchema,
  type ActivityQueryDto,
  type AlertsQueryDto,
  type DashboardQueryDto,
  type HealthScoreQueryDto,
  type KpisQueryDto,
  type QuickActionsQueryDto,
  type TeamQueryDto,
  type TrendsQueryDto,
} from './dto/dashboard-query.dto';
import { ClientDashboardService } from './services/dashboard.service';

/**
 * BE-30 — Client dashboard REST surface (`/api/v1/dashboard/*`).
 *
 * Every endpoint is read-only, tenant-scoped, and store-scoped where
 * applicable. The guard stack is:
 *
 *   JwtAuthGuard         — authenticated user required
 *   RolesGuard           — role gate (owner / manager / staff / auditor)
 *   PermissionsGuard     — pass-through here; no `@RequirePermissions`
 *                          on these handlers because the BE-08
 *                          permission catalog doesn't yet expose a
 *                          `dashboard:read` key. The orchestrator
 *                          checklist tracks adding it in the next
 *                          RBAC sweep.
 *   TenantScopeGuard     — derives tenant from JWT, blocks cross-tenant
 *   StoreScopeGuard      — verifies the user has access to `:storeId`
 *                          when `@RequireStore()` is present
 *
 * The `multi-store` endpoint is `owner`-only because the aggregated
 * view is privileged — even managers see only their assigned stores.
 */
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard, StoreScopeGuard)
export class ClientDashboardController {
  constructor(private readonly dashboard: ClientDashboardService) {}

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor')
  @RequireTenant()
  @RequireStore()
  getDashboard(
    @Query(new ZodValidationPipe(DashboardQuerySchema)) query: DashboardQueryDto,
  ): Promise<unknown> {
    return this.dashboard.getDashboard(query.storeId, {
      dateRange: optionalDateRange(query.from, query.to),
    });
  }

  @Get('kpis')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor')
  @RequireTenant()
  @RequireStore()
  getKpis(@Query(new ZodValidationPipe(KpisQuerySchema)) query: KpisQueryDto): Promise<unknown> {
    return this.dashboard.getKpis(
      query.storeId,
      optionalDateRange(query.from, query.to) ?? defaultRange(),
    );
  }

  @Get('alerts')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor')
  @RequireTenant()
  @RequireStore()
  getAlerts(
    @Query(new ZodValidationPipe(AlertsQuerySchema)) query: AlertsQueryDto,
  ): Promise<unknown> {
    return this.dashboard.getAlerts(query.storeId);
  }

  @Get('quick-actions')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor')
  @RequireTenant()
  @RequireStore()
  getQuickActions(
    @Query(new ZodValidationPipe(QuickActionsQuerySchema)) query: QuickActionsQueryDto,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.dashboard.getQuickActions(query.storeId, userId);
  }

  @Get('trends')
  @Version('1')
  @Roles('owner', 'manager')
  @RequireTenant()
  @RequireStore()
  getTrends(
    @Query(new ZodValidationPipe(TrendsQuerySchema)) query: TrendsQueryDto,
  ): Promise<unknown> {
    return this.dashboard.getTrends(
      query.storeId,
      optionalDateRange(query.from, query.to) ?? defaultRange(),
    );
  }

  @Get('team')
  @Version('1')
  @Roles('owner', 'manager')
  @RequireTenant()
  @RequireStore()
  getTeam(@Query(new ZodValidationPipe(TeamQuerySchema)) query: TeamQueryDto): Promise<unknown> {
    return this.dashboard.getTeamPerformance(
      query.storeId,
      optionalDateRange(query.from, query.to) ?? defaultRange(),
    );
  }

  @Get('activity')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor')
  @RequireTenant()
  @RequireStore()
  getActivity(
    @Query(new ZodValidationPipe(ActivityQuerySchema)) query: ActivityQueryDto,
  ): Promise<unknown> {
    return this.dashboard.getRecentActivity(query.storeId, query.limit);
  }

  @Get('health-score')
  @Version('1')
  @Roles('owner', 'manager')
  @RequireTenant()
  @RequireStore()
  getHealthScore(
    @Query(new ZodValidationPipe(HealthScoreQuerySchema)) query: HealthScoreQueryDto,
  ): Promise<unknown> {
    return this.dashboard.getHealthScore(query.storeId);
  }

  @Get('multi-store')
  @Version('1')
  @Roles('owner')
  @RequireTenant()
  getMultiStore(@CurrentTenant() tenantId: string): Promise<unknown> {
    return this.dashboard.getMultiStoreSummary(tenantId);
  }
}

function defaultRange(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from, to };
}

function optionalDateRange(
  from: string | undefined,
  to: string | undefined,
): { from: Date; to: Date } | undefined {
  if (!from && !to) return undefined;
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : (() => {
        const f = new Date(toDate);
        f.setUTCDate(f.getUTCDate() - 30);
        return f;
      })();
  return { from: fromDate, to: toDate };
}
