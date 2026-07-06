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
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import {
  AddContactSchema,
  type AddContactDto,
  CreateSupplierSchema,
  type CreateSupplierDto,
} from './dto/create-supplier.dto';
import {
  ExportSuppliersSchema,
  type ExportSuppliersDto,
  ListSuppliersSchema,
  type ListSuppliersDto,
} from './dto/list-suppliers.dto';
import { ImportSuppliersSchema, type ImportSuppliersDto } from './dto/import-suppliers.dto';
import {
  BlacklistSupplierSchema,
  type BlacklistSupplierDto,
  UpdateSupplierSchema,
  type UpdateSupplierDto,
} from './dto/update-supplier.dto';
import { SuppliersService } from './suppliers.service';

/**
 * BE-25 — Suppliers REST surface (mounted under `/api/v1/suppliers`).
 *
 * Guards: BE-08 stack — `JwtAuthGuard + RolesGuard + TenantScopeGuard`.
 *
 * **Note on permissions:** the spec calls for `suppliers:read`,
 * `suppliers:write`, `suppliers:delete`. Those permission strings
 * are not yet present in `@/modules/auth/types/permission.types.ts`
 * and adding them is **out of scope** for BE-25 per the orchestrator
 * checklist (RBAC permission constants are owned by the auth phase).
 * The controller therefore enforces access via `@Roles(...)` alone
 * for now; once `suppliers:*` permissions land, swap each handler to
 * `@RequirePermissions('suppliers:read'|'suppliers:write'|'suppliers:delete')`
 * and add `PermissionsGuard` to the `@UseGuards` list.
 *
 * Static segments (`/search`, `/import`, `/export`, `/contacts/:id`)
 * are declared BEFORE `:id` routes so Express resolves them
 * correctly.
 */
@Controller('suppliers')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class SuppliersController {
  constructor(private readonly service: SuppliersService) {}

  /* ─────────────────── CRUD ─────────────────── */

  @Post()
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequireTenant()
  create(
    @Body(new ZodValidationPipe(CreateSupplierSchema)) dto: CreateSupplierDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.create(tenantId, userId, dto);
  }

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListSuppliersSchema)) query: ListSuppliersDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.list(tenantId, query);
  }

  /* ─────────────────── Static segments ahead of :id ─────────────────── */

  @Get('search')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequireTenant()
  search(
    @Query('q') q: string,
    @Query('limit') limit: string | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    const parsedLimit = limit ? Math.min(100, Math.max(1, Number(limit))) : 25;
    return this.service.search(tenantId, q ?? '', parsedLimit);
  }

  @Post('import')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequireTenant()
  async bulkImport(
    @Body(new ZodValidationPipe(ImportSuppliersSchema)) dto: ImportSuppliersDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    const buffer = Buffer.from(dto.fileBase64, 'base64');
    return this.service.bulkImport(tenantId, userId, dto.fileType, buffer, dto.fileName);
  }

  @Get('export')
  @Version('1')
  @Header('X-Content-Type-Options', 'nosniff')
  @Roles('owner', 'manager', 'admin')
  @RequireTenant()
  async exportAll(
    @Query(new ZodValidationPipe(ExportSuppliersSchema)) query: ExportSuppliersDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType, fileName } = await this.service.exportAll(
      tenantId,
      userId,
      query.format,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }

  /* ─────────────────── Contacts (top-level for delete) ─────────────────── */

  @Delete('contacts/:contactId')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'admin')
  @RequireTenant()
  async removeContact(
    @Param('contactId', new ParseUuidPipe()) contactId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.service.removeContact(tenantId, userId, contactId);
  }

  /* ─────────────────── :id-scoped ─────────────────── */

  @Get(':id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
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
  @RequireTenant()
  update(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateSupplierSchema)) dto: UpdateSupplierDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.update(tenantId, userId, id, dto);
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'admin')
  @RequireTenant()
  async remove(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.service.softDelete(tenantId, userId, id);
  }

  /* ─────────────────── Status workflow ─────────────────── */

  @Post(':id/activate')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
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
  @RequireTenant()
  deactivate(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.deactivate(tenantId, userId, id);
  }

  @Post(':id/blacklist')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @RequireTenant()
  blacklist(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(BlacklistSupplierSchema)) dto: BlacklistSupplierDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.blacklist(tenantId, userId, id, dto.reason);
  }

  /* ─────────────────── Contacts under :id ─────────────────── */

  @Get(':id/contacts')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequireTenant()
  listContacts(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.listContacts(tenantId, id);
  }

  @Post(':id/contacts')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequireTenant()
  addContact(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(AddContactSchema)) dto: AddContactDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.service.addContact(tenantId, userId, id, dto);
  }

  /* ─────────────────── Performance ─────────────────── */

  @Get(':id/performance')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequireTenant()
  getPerformance(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.service.getPerformance(tenantId, id);
  }
}
