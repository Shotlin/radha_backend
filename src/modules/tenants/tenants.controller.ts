import { Body, Controller, Get, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  Public,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import { OnboardTenantDto, OnboardTenantSchema } from './dto/onboard-tenant.dto';
import { TenantsRepository } from './repositories/tenants.repository';
import { TenantOnboardingService } from './services/tenant-onboarding.service';

@Controller('tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantsController {
  constructor(
    private readonly onboarding: TenantOnboardingService,
    private readonly tenants: TenantsRepository,
  ) {}

  @Post('onboard')
  @Public()
  @Version('1')
  @HttpCode(201)
  onboard(@Body(new ZodValidationPipe(OnboardTenantSchema)) dto: OnboardTenantDto) {
    return this.onboarding.onboard(dto);
  }

  @Get('me')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  async me(@CurrentTenant() tenantId: string | null, @CurrentUser() user: AuthenticatedUser) {
    if (!tenantId) {
      return { tenant: null, user: { id: user.id, role: user.role } };
    }
    const tenant = await this.tenants.findById(tenantId);
    return { tenant, user: { id: user.id, role: user.role } };
  }
}
