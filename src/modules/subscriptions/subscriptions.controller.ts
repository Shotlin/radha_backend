import { Body, Controller, Get, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  Public,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import { CancelSubscriptionDto, CancelSubscriptionSchema } from './dto/cancel-subscription.dto';
import { UpgradePlanDto, UpgradePlanSchema } from './dto/upgrade-plan.dto';
import { SubscriptionsService } from './subscriptions.service';

/**
 * BE-28 — REST surface (`/api/v1/subscriptions/*`).
 *
 * Endpoint table:
 *   GET  /plans       Public      List public plans
 *   GET  /status      Bearer      Current tenant subscription status
 *   GET  /usage       Bearer      Current usage stats
 *   POST /upgrade     Bearer      Upgrade or downgrade plan
 *   POST /cancel      Bearer      Cancel (graceful — at period end)
 *   POST /reactivate  Bearer      Reactivate cancelled subscription
 *
 * The system-only `POST /events` webhook lives elsewhere (BE-28 v2);
 * v1 doesn't need it because no payment provider is wired.
 */
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly service: SubscriptionsService) {}

  @Get('plans')
  @Version('1')
  @Public()
  listPlans(): Promise<unknown> {
    return this.service.listPlans(false);
  }

  @Get('status')
  @Version('1')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequireTenant()
  getStatus(@CurrentTenant() tenantId: string): Promise<unknown> {
    return this.service.getStatus(tenantId);
  }

  @Get('usage')
  @Version('1')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles('owner', 'manager', 'admin')
  @RequireTenant()
  getUsage(@CurrentTenant() tenantId: string): Promise<unknown> {
    return this.service.getCurrentUsage(tenantId);
  }

  @Post('upgrade')
  @Version('1')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles('owner', 'admin')
  @RequireTenant()
  upgrade(
    @Body(new ZodValidationPipe(UpgradePlanSchema)) dto: UpgradePlanDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.upgradeToPlan(tenantId, dto.planCode, userId);
  }

  @Post('cancel')
  @Version('1')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles('owner', 'admin')
  @RequireTenant()
  cancel(
    @Body(new ZodValidationPipe(CancelSubscriptionSchema)) dto: CancelSubscriptionDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.cancel(tenantId, dto.reason, userId);
  }

  @Post('reactivate')
  @Version('1')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
  @Roles('owner', 'admin')
  @RequireTenant()
  reactivate(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.reactivate(tenantId, userId);
  }
}
