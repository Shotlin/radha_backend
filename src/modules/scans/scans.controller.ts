import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
  CreateSessionDto,
  CreateSessionSchema,
  EndSessionDto,
  EndSessionSchema,
  ListItemsQueryDto,
  ListItemsQuerySchema,
  ListSessionsQueryDto,
  ListSessionsQuerySchema,
  ScanBatchDto,
  ScanBatchSchema,
  ScanItemDto,
  ScanItemSchema,
} from './dto/scans.dto';
import {
  BulkSyncDto,
  BulkSyncSchema,
  ListSyncBatchesQueryDto,
  ListSyncBatchesQuerySchema,
} from './dto/sync.dto';
import { BulkScanService } from './services/bulk-scan.service';
import { ScanItemService } from './services/scan-item.service';
import { ScanSessionService } from './services/scan-session.service';
import { ScanSummaryService } from './services/scan-summary.service';

/**
 * BE-16 — Scan REST surface.
 *
 *   POST   /scan-sessions                 — create session (one active per user/store)
 *   GET    /scan-sessions                 — list (filtered)
 *   GET    /scan-sessions/active          — current user's active session for a store
 *   GET    /scan-sessions/:id             — read session (with summary)
 *   POST   /scan-sessions/:id/end         — complete the session
 *   POST   /scan-sessions/:id/abandon     — abandon (no completion)
 *   GET    /scan-sessions/:id/summary     — recomputed summary
 *   POST   /scan-sessions/:id/items       — record one scan
 *   POST   /scan-sessions/:id/items/batch — record many scans
 *   GET    /scan-sessions/:id/items       — list items
 *   DELETE /scan-sessions/:id/items/:itemId — remove from session
 */
@Controller('scan-sessions')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class ScansController {
  constructor(
    private readonly sessions: ScanSessionService,
    private readonly items: ScanItemService,
    private readonly summary: ScanSummaryService,
    private readonly bulk: BulkScanService,
  ) {}

  /* ─────────────────── Sync batches (BE-17) — must precede `:id` ─────────────────── */

  @Get('sync-batches')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:read')
  @RequireTenant()
  listBatches(
    @Query(new ZodValidationPipe(ListSyncBatchesQuerySchema)) query: ListSyncBatchesQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.bulk.listBatches(
      tenantId,
      { sessionId: query.sessionId, status: query.status },
      query.limit,
    );
  }

  @Get('sync-batches/:batchId')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:read')
  @RequireTenant()
  batchStatus(
    @Param('batchId', new ParseUuidPipe()) batchId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.bulk.getStatus(tenantId, batchId);
  }

  @Post('sync-batches/:batchId/cancel')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  cancelBatch(
    @Param('batchId', new ParseUuidPipe()) batchId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.bulk.cancel(tenantId, userId, batchId);
  }

  /* ─────────────────── Sessions ─────────────────── */

  @Post()
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  create(
    @Body(new ZodValidationPipe(CreateSessionSchema)) dto: CreateSessionDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.sessions.create(tenantId, userId, dto);
  }

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:read')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListSessionsQuerySchema)) query: ListSessionsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.sessions.list(
      tenantId,
      {
        storeId: query.storeId,
        userId: query.userId,
        status: query.status,
        type: query.type,
      },
      query.limit,
    );
  }

  @Get('active')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:read')
  @RequireTenant()
  active(
    @Query('storeId', new ParseUuidPipe()) storeId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.sessions.getActive(tenantId, userId, storeId);
  }

  @Get(':id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:read')
  @RequireTenant()
  get(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.sessions.findById(tenantId, id);
  }

  @Get(':id/summary')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:read')
  @RequireTenant()
  summarise(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.summary.forSession(id, tenantId);
  }

  @Post(':id/end')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  end(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(EndSessionSchema)) dto: EndSessionDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.sessions.end(tenantId, userId, id, dto);
  }

  @Post(':id/abandon')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  abandon(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.sessions.abandon(tenantId, userId, id);
  }

  /* ─────────────────── Items ─────────────────── */

  @Post(':id/items')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  recordItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(ScanItemSchema)) dto: ScanItemDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.items.recordScan(tenantId, userId, id, dto);
  }

  @Post(':id/items/batch')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  recordBatch(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(ScanBatchSchema)) dto: ScanBatchDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.items.recordBatch(tenantId, userId, id, dto.items);
  }

  @Post(':id/bulk-sync')
  @Version('1')
  @HttpCode(202)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  bulkSync(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(BulkSyncSchema)) dto: BulkSyncDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.bulk.submit(tenantId, userId, id, dto);
  }

  @Get(':id/items')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:read')
  @RequireTenant()
  listItems(
    @Param('id', new ParseUuidPipe()) id: string,
    @Query(new ZodValidationPipe(ListItemsQuerySchema)) query: ListItemsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.items.listForSession(tenantId, id, query.limit);
  }

  @Delete(':id/items/:itemId')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('scans:write')
  @RequireTenant()
  async removeItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('itemId', new ParseUuidPipe()) itemId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.items.removeFromSession(tenantId, userId, id, itemId);
  }
}
