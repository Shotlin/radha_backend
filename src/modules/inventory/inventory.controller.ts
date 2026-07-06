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

import { AdjustStockDto, AdjustStockSchema } from './dto/adjust-stock.dto';
import {
  InventorySummaryQueryDto,
  InventorySummaryQuerySchema,
  ListInventoryQueryDto,
  ListInventoryQuerySchema,
  ListMovementsQueryDto,
  ListMovementsQuerySchema,
  StoreScopedQueryDto,
  StoreScopedQuerySchema,
} from './dto/list-inventory.dto';
import { LowStockRuleDto, LowStockRuleSchema } from './dto/low-stock-rule.dto';
import {
  CancelStockCountDto,
  CancelStockCountSchema,
  RecordCountLineDto,
  RecordCountLineSchema,
  StartStockCountDto,
  StartStockCountSchema,
} from './dto/stock-count.dto';
import { StockInDto, StockInSchema } from './dto/stock-in.dto';
import { StockOutDto, StockOutSchema } from './dto/stock-out.dto';
import { InventoryService } from './inventory.service';

/**
 * BE-27 — Inventory REST surface (`/api/v1/inventory/*`).
 *
 * Permission model (BE-08 catalog):
 *   - reads          : `inventory:read`
 *   - writes (in/out): `inventory:write`
 *   - adjustments    : `inventory:adjust`
 *
 * All routes pass through the BE-08 guard stack and require an
 * authenticated tenant. Static path segments precede `:id` routes
 * so the router is deterministic.
 */
@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /* ─────────────────── Static segments first ─────────────────── */

  @Get('summary')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  summary(
    @Query(new ZodValidationPipe(InventorySummaryQuerySchema)) query: InventorySummaryQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.getStoreSummary(tenantId, query.storeId);
  }

  @Get('category-breakdown')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  categoryBreakdown(
    @Query(new ZodValidationPipe(StoreScopedQuerySchema)) query: StoreScopedQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.getCategoryBreakdown(tenantId, query.storeId);
  }

  @Get('counts')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  listStock(
    @Query(new ZodValidationPipe(ListInventoryQuerySchema)) query: ListInventoryQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.listStock(tenantId, query);
  }

  @Get('movements')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  movements(
    @Query(new ZodValidationPipe(ListMovementsQuerySchema)) query: ListMovementsQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.getMovementHistory(tenantId, query);
  }

  @Get('low-stock')
  @Version('1')
  @Roles('owner', 'manager', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  lowStock(
    @Query(new ZodValidationPipe(StoreScopedQuerySchema)) query: StoreScopedQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.getLowStockAlerts(tenantId, query.storeId);
  }

  @Get('low-stock-rules')
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  listRules(
    @Query(new ZodValidationPipe(StoreScopedQuerySchema)) query: StoreScopedQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.listLowStockRules(tenantId, query.storeId);
  }

  /* ─────────────────── Movements ─────────────────── */

  @Post('stock-in')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  stockIn(
    @Body(new ZodValidationPipe(StockInSchema)) dto: StockInDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.stockIn(tenantId, userId, dto);
  }

  @Post('stock-out')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  stockOut(
    @Body(new ZodValidationPipe(StockOutSchema)) dto: StockOutDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.stockOut(tenantId, userId, dto);
  }

  @Post('adjust')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:adjust')
  @RequireTenant()
  adjust(
    @Body(new ZodValidationPipe(AdjustStockSchema)) dto: AdjustStockDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.adjust(tenantId, userId, dto);
  }

  /* ─────────────────── Low-stock rules ─────────────────── */

  @Post('low-stock-rules')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  upsertRule(
    @Body(new ZodValidationPipe(LowStockRuleSchema)) dto: LowStockRuleDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.setLowStockRule(tenantId, userId, dto);
  }

  @Delete('low-stock-rules/:id')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:write')
  @RequireTenant()
  async deleteRule(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.inventory.deleteLowStockRule(tenantId, userId, id);
  }

  /* ─────────────────── Stock counts ─────────────────── */

  @Post('stock-counts')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:adjust')
  @RequireTenant()
  startCount(
    @Body(new ZodValidationPipe(StartStockCountSchema)) dto: StartStockCountDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.startStockCount(tenantId, userId, dto);
  }

  @Get('stock-counts')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  listCounts(
    @Query(new ZodValidationPipe(StoreScopedQuerySchema)) query: StoreScopedQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.listStockCounts(tenantId, query.storeId);
  }

  @Get('stock-counts/:id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  getCount(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.getStockCount(tenantId, id);
  }

  @Post('stock-counts/:id/lines')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('inventory:adjust')
  @RequireTenant()
  recordLine(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(RecordCountLineSchema)) dto: RecordCountLineDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.recordCountLine(tenantId, userId, id, dto);
  }

  @Get('stock-counts/:id/lines')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  listLines(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.listCountLines(tenantId, id);
  }

  @Post('stock-counts/:id/complete')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:adjust')
  @RequireTenant()
  completeCount(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.completeStockCount(tenantId, userId, id);
  }

  @Post('stock-counts/:id/cancel')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('inventory:adjust')
  @RequireTenant()
  cancelCount(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(CancelStockCountSchema)) dto: CancelStockCountDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.inventory.cancelStockCount(tenantId, userId, id, dto.reason);
  }

  /* ─────────────────── Item details ─────────────────── */

  @Get('items/:id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('inventory:read')
  @RequireTenant()
  getItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.inventory.getItemById(tenantId, id);
  }
}
