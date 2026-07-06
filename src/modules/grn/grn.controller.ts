import {
  Body,
  Controller,
  Delete,
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
  RequirePermissions,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import {
  AddItemsDto,
  AddItemsSchema,
  CancelGrnDto,
  CancelGrnSchema,
  CreateGrnDto,
  CreateGrnSchema,
  GrnStatsQueryDto,
  GrnStatsQuerySchema,
  ListGrnsQueryDto,
  ListGrnsQuerySchema,
  ReverseGrnDto,
  ReverseGrnSchema,
  UpdateGrnDto,
  UpdateGrnItemDto,
  UpdateGrnItemSchema,
  UpdateGrnSchema,
} from './dto/grn.dto';
import { GrnService } from './grn.service';

/**
 * BE-26 — GRN REST surface (`/api/v1/grn/*`).
 *
 * Static segments (`stats`) precede `:id` routes so `/grn/stats`
 * resolves correctly. Posting and reversal are POST endpoints with
 * empty / reason-only bodies.
 *
 * Permissions:
 *   - reads     : `grn:read`
 *   - writes    : `grn:write`
 *   - post      : `grn:post`
 *   - cancel    : `grn:cancel`
 *   - reverse   : `grn:cancel` (no dedicated `grn:reverse` permission
 *                 in the BE-08 catalog yet — flagged in the BE-26
 *                 INTEGRATION CHECKLIST so it can be added when the
 *                 RBAC catalog is next opened).
 *
 * Tenant scoping is mandatory via `@RequireTenant()`.
 */
@Controller('grn')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class GrnController {
  constructor(private readonly grn: GrnService) {}

  /* ─────────────────── Static segments first ─────────────────── */

  @Get('stats')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('grn:read')
  @RequireTenant()
  stats(
    @Query(new ZodValidationPipe(GrnStatsQuerySchema)) query: GrnStatsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.grn.getStats(tenantId, query);
  }

  /* ─────────────────── CRUD ─────────────────── */

  @Post()
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('grn:write')
  @RequireTenant()
  create(
    @Body(new ZodValidationPipe(CreateGrnSchema)) dto: CreateGrnDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.grn.createDraft(tenantId, userId, dto);
  }

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('grn:read')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListGrnsQuerySchema)) query: ListGrnsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.grn.list(tenantId, query);
  }

  @Get(':id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('grn:read')
  @RequireTenant()
  get(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.grn.findById(tenantId, id);
  }

  @Patch(':id')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('grn:write')
  @RequireTenant()
  update(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateGrnSchema)) dto: UpdateGrnDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.grn.updateDraft(tenantId, userId, id, dto);
  }

  /* ─────────────────── Items ─────────────────── */

  @Post(':id/items')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('grn:write')
  @RequireTenant()
  addItems(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(AddItemsSchema)) body: AddItemsDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.grn.addItems(tenantId, userId, id, body.items);
  }

  @Patch(':id/items/:itemId')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('grn:write')
  @RequireTenant()
  updateItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('itemId', new ParseUuidPipe()) itemId: string,
    @Body(new ZodValidationPipe(UpdateGrnItemSchema)) dto: UpdateGrnItemDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.grn.updateItem(tenantId, userId, id, itemId, dto);
  }

  @Delete(':id/items/:itemId')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('grn:write')
  @RequireTenant()
  async removeItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('itemId', new ParseUuidPipe()) itemId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.grn.removeItem(tenantId, userId, id, itemId);
  }

  /* ─────────────────── Workflow ─────────────────── */

  @Post(':id/validate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('grn:read')
  @RequireTenant()
  validate(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.grn.validate(tenantId, id);
  }

  @Post(':id/post')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('grn:post')
  @RequireTenant()
  post(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.grn.post(tenantId, userId, id);
  }

  @Post(':id/cancel')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('grn:cancel')
  @RequireTenant()
  cancel(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(CancelGrnSchema)) dto: CancelGrnDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.grn.cancel(tenantId, userId, id, dto.reason);
  }

  @Post(':id/reverse')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequirePermissions('grn:cancel')
  @RequireTenant()
  reverse(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(ReverseGrnSchema)) dto: ReverseGrnDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.grn.reverse(tenantId, userId, id, dto.reason);
  }
}
