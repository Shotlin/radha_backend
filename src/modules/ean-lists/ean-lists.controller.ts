import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  Version,
} from '@nestjs/common';
import type { Response } from 'express';

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
  CreateEanListDto,
  CreateEanListSchema,
  ImportInlineDto,
  ImportInlineSchema,
  ListEanListsQueryDto,
  ListEanListsQuerySchema,
  PaginationQueryDto,
  PaginationQuerySchema,
  UpdateEanListDto,
  UpdateEanListSchema,
  ValidateBatchDto,
  ValidateBatchSchema,
  ValidateEanDto,
  ValidateEanSchema,
} from './dto/ean-lists.dto';
import { EanListsService } from './ean-lists.service';
import { EanMatcherService } from './services/ean-matcher.service';

/**
 * BE-15 — EAN list management + import + validation REST surface.
 *
 * Mounted under `/api/v1/ean-lists/...` behind the BE-08 guard
 * stack. Consumer-tier callers cannot reach any of these routes —
 * `products:write` is required for management, `products:read` for
 * read-only access.
 */
@Controller('ean-lists')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class EanListsController {
  constructor(
    private readonly service: EanListsService,
    private readonly matcher: EanMatcherService,
  ) {}

  /* ─────────────────── List CRUD ─────────────────── */

  @Post()
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  create(
    @Body(new ZodValidationPipe(CreateEanListSchema)) dto: CreateEanListDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.create(tenantId, userId, dto);
  }

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListEanListsQuerySchema)) query: ListEanListsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.list(tenantId, query);
  }

  /* ─────────────────── Validation (must precede `:id` routes) ─────────────────── */

  @Post('validate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  validate(
    @Body(new ZodValidationPipe(ValidateEanSchema)) dto: ValidateEanDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.matcher.validate(dto.ean, tenantId, dto.storeId);
  }

  @Post('validate/batch')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  async validateBatch(
    @Body(new ZodValidationPipe(ValidateBatchSchema)) dto: ValidateBatchDto,
    @CurrentTenant() tenantId: string,
  ): Promise<Record<string, unknown>> {
    const map = await this.matcher.validateBatch(dto.eans, tenantId, dto.storeId);
    return Object.fromEntries(map);
  }

  /* ─────────────────── Imports — mounted under /imports to keep
                         them out of the `:id` route space ────────── */

  @Get('imports/:batchId')
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  importStatus(
    @Param('batchId', new ParseUuidPipe()) batchId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.getImportStatus(tenantId, batchId);
  }

  @Get('imports/:batchId/errors')
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  importErrors(
    @Param('batchId', new ParseUuidPipe()) batchId: string,
    @Query(new ZodValidationPipe(PaginationQuerySchema)) query: PaginationQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.getImportErrors(tenantId, batchId, query.limit);
  }

  @Get('imports/:batchId/errors/csv')
  @Version('1')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  async importErrorsCsv(
    @Param('batchId', new ParseUuidPipe()) batchId: string,
    @CurrentTenant() tenantId: string,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.service.downloadErrorsCsv(tenantId, batchId);
    res.setHeader('Content-Disposition', `attachment; filename="errors-${batchId}.csv"`);
    res.send(csv);
  }

  @Post('imports/:batchId/cancel')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  cancelImport(
    @Param('batchId', new ParseUuidPipe()) batchId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.cancelImport(tenantId, userId, batchId);
  }

  /* ─────────────────── List-scoped routes ─────────────────── */

  @Get(':id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  get(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.findById(tenantId, id);
  }

  @Patch(':id')
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  update(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateEanListSchema)) dto: UpdateEanListDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.update(tenantId, userId, id, dto);
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'admin')
  @RequirePermissions('products:delete')
  @RequireTenant()
  async remove(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.service.softDelete(tenantId, userId, id);
  }

  @Post(':id/activate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  activate(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.activate(tenantId, userId, id);
  }

  @Post(':id/deactivate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  deactivate(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.deactivate(tenantId, userId, id);
  }

  @Post(':id/import')
  @Version('1')
  @HttpCode(202)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  importInline(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(ImportInlineSchema)) dto: ImportInlineDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.importInline(tenantId, userId, id, dto);
  }

  @Get(':id/items')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  listItems(
    @Param('id', new ParseUuidPipe()) id: string,
    @Query(new ZodValidationPipe(PaginationQuerySchema)) query: PaginationQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.listItems(tenantId, id, query.limit);
  }
}
