import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import {
  UpsertAllergenProfileDto,
  UpsertAllergenProfileSchema,
} from '../dto/upsert-allergen-profile.dto';
import { AllergenProfileService } from '../services/allergen-profile.service';

/**
 * BE-37 — Allergen profile REST controller.
 *
 * Endpoints:
 *   POST   /api/v1/allergen/profiles          Create profile
 *   PUT    /api/v1/allergen/profiles/:id       Update profile
 *   GET    /api/v1/allergen/profiles           List user's profiles
 *   DELETE /api/v1/allergen/profiles/:id       Soft delete
 *   POST   /api/v1/allergen/profiles/:id/activate  Set as active for next scan
 */
@Controller('allergen/profiles')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('owner', 'manager', 'staff', 'auditor', 'admin')
@RequireTenant()
export class AllergenController {
  constructor(private readonly service: AllergenProfileService) {}

  @Post()
  @Version('1')
  create(
    @Body(new ZodValidationPipe(UpsertAllergenProfileSchema)) dto: UpsertAllergenProfileDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('subscriptionTier') subscriptionTier: string,
  ) {
    return this.service.upsert(tenantId, userId, { ...dto, id: undefined }, subscriptionTier ?? 'free');
  }

  @Put(':id')
  @Version('1')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpsertAllergenProfileSchema)) dto: UpsertAllergenProfileDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.upsert(tenantId, userId, { ...dto, id }, 'free');
  }

  @Get()
  @Version('1')
  list(@CurrentTenant() tenantId: string, @CurrentUser('id') userId: string) {
    return this.service.listByUser(tenantId, userId);
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(200)
  delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.delete(tenantId, userId, id);
  }

  @Post(':id/activate')
  @Version('1')
  @HttpCode(200)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.setActive(tenantId, userId, id);
  }
}
