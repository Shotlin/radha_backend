import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
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
  CreateStoreDto,
  CreateStoreSchema,
  GrantStoreAccessDto,
  GrantStoreAccessSchema,
} from '@/modules/tenants/dto/onboard-tenant.dto';

import { StoreScopeGuard, RequireStore } from './guards/store-scope.guard';
import { StoresService } from './stores.service';

@Controller('stores')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard, StoreScopeGuard)
@RequireTenant()
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Post()
  @Version('1')
  @Roles('owner', 'admin')
  @RequirePermissions('users:invite')
  create(
    @Body(new ZodValidationPipe(CreateStoreSchema)) dto: CreateStoreDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stores.create(tenantId, userId, dto);
  }

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  list(@CurrentTenant() tenantId: string) {
    return this.stores.list(tenantId);
  }

  @Get(':storeId')
  @Version('1')
  @RequireStore()
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  get(@CurrentTenant() tenantId: string, @Param('storeId', new ParseUuidPipe()) storeId: string) {
    return this.stores.get(tenantId, storeId);
  }

  @Post(':storeId/access')
  @Version('1')
  @RequireStore()
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('users:invite')
  @HttpCode(201)
  grant(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') byUserId: string,
    @Param('storeId', new ParseUuidPipe()) storeId: string,
    @Body(new ZodValidationPipe(GrantStoreAccessSchema)) dto: GrantStoreAccessDto,
  ) {
    return this.stores.grantAccess(tenantId, storeId, byUserId, dto);
  }

  @Delete(':storeId/access/:userId')
  @Version('1')
  @RequireStore()
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('users:invite')
  @HttpCode(204)
  async revoke(
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') byUserId: string,
    @Param('storeId', new ParseUuidPipe()) storeId: string,
    @Param('userId', new ParseUuidPipe()) targetUserId: string,
  ): Promise<void> {
    await this.stores.revokeAccess(tenantId, storeId, byUserId, targetUserId);
  }
}
