import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
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
  SyncBatchDto,
  SyncBatchResultDto,
  SyncBatchSchema,
} from '../dto/sync-batch.dto';
import {
  SyncChangesQueryDto,
  SyncChangesQuerySchema,
  SyncChangesResponseDto,
} from '../dto/sync-changes.dto';
import { SyncService } from '../services/sync.service';

/**
 * BE-44 — Sync REST controller.
 *
 * Endpoints (all under `/api/v1/sync`):
 *   POST /sync/scans
 *   POST /sync/saved-products
 *   POST /sync/allergen-profiles
 *   GET  /sync/changes?since=&cursor=&limit=
 *
 * Idempotency on the POSTs is handled by `IdempotencyMiddleware` —
 * the controller itself is transport only.
 */
@Controller('sync')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('owner', 'manager', 'staff', 'auditor', 'admin')
@RequireTenant()
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('scans')
  @Version('1')
  @HttpCode(200)
  syncScans(
    @Body(new ZodValidationPipe(SyncBatchSchema)) batch: SyncBatchDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser('id') userId: string,
  ): Promise<SyncBatchResultDto> {
    return this.syncService.processBatch(batch, {
      tenantId,
      userId,
      resource: 'scans',
    });
  }

  @Post('saved-products')
  @Version('1')
  @HttpCode(200)
  syncSavedProducts(
    @Body(new ZodValidationPipe(SyncBatchSchema)) batch: SyncBatchDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser('id') userId: string,
  ): Promise<SyncBatchResultDto> {
    return this.syncService.processBatch(batch, {
      tenantId,
      userId,
      resource: 'saved-products',
    });
  }

  @Post('allergen-profiles')
  @Version('1')
  @HttpCode(200)
  syncAllergenProfiles(
    @Body(new ZodValidationPipe(SyncBatchSchema)) batch: SyncBatchDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser('id') userId: string,
  ): Promise<SyncBatchResultDto> {
    return this.syncService.processBatch(batch, {
      tenantId,
      userId,
      resource: 'allergen-profiles',
    });
  }

  @Get('changes')
  @Version('1')
  getChanges(
    @Query(new ZodValidationPipe(SyncChangesQuerySchema))
    query: SyncChangesQueryDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser('id') userId: string,
  ): Promise<SyncChangesResponseDto> {
    return this.syncService.getChanges({ tenantId, userId }, query);
  }
}
