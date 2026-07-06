import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { InventoryBatchesRepository } from './repositories/inventory-batches.repository';
import { InventoryItemsRepository } from './repositories/inventory-items.repository';
import { StockMovementsRepository } from './repositories/stock-movements.repository';
import { InventoryAggregatorService } from './services/inventory-aggregator.service';
import { LowStockAlertService } from './services/low-stock-alert.service';
import { StockCountService } from './services/stock-count.service';
import { StockMovementService } from './services/stock-movement.service';
import {
  AdjustStockInput,
  CategoryBreakdownEntry,
  IInventoryService,
  InventoryBatch,
  InventoryItem,
  InventoryMovementRequest,
  InventoryMovementResult,
  InventorySummary,
  ListInventoryFilters,
  LowStockAlert,
  LowStockRule,
  LowStockRuleInput,
  MovementHistoryFilters,
  PaginatedResult,
  RecordStockCountLineInput,
  StartStockCountInput,
  StockCount,
  StockCountLine,
  StockCountResult,
  StockInInput,
  StockMovement,
  StockMovementResult,
  StockOutInput,
} from './types/inventory.types';

/**
 * BE-27 — Top-level inventory orchestrator.
 *
 * Plays two roles:
 *
 *  1. The public façade for HTTP callers via `inventory.controller.ts`.
 *     Reads + workflow methods route through here so the controller
 *     stays transport-only.
 *
 *  2. The cross-phase contract `IInventoryService` consumed by the
 *     BE-26 GRN module. `applyInbound` / `applyOutbound` are the
 *     methods GRN posting / reversal call. The orchestrator wires
 *     this service against `INVENTORY_SERVICE_TOKEN` (see the
 *     INTEGRATION CHECKLIST in the BE-27 handoff).
 *
 * Audit logging happens here for the headline mutations (stock-in,
 * stock-out, adjust). Sub-services emit detailed events; the audit
 * log captures the user-facing intent.
 */
@Injectable()
export class InventoryService implements IInventoryService {
  constructor(
    private readonly itemsRepo: InventoryItemsRepository,
    private readonly batchesRepo: InventoryBatchesRepository,
    private readonly movementsRepo: StockMovementsRepository,
    private readonly movementService: StockMovementService,
    private readonly alertService: LowStockAlertService,
    private readonly countService: StockCountService,
    private readonly aggregator: InventoryAggregatorService,
    private readonly auditLog: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  /* ─────────────────── Movements (public) ─────────────────── */

  async stockIn(
    tenantId: string,
    userId: string,
    input: StockInInput,
  ): Promise<StockMovementResult> {
    const result = await this.movementService.stockIn(tenantId, userId, input);
    await this.auditLog.logAction({
      action: 'CREATE',
      resourceType: 'StockMovement',
      resourceId: result.movement.id,
      userId,
      tenantId,
      success: true,
      metadata: {
        type: 'in',
        productId: input.productId,
        storeId: input.storeId,
        quantity: input.quantity,
        reason: input.reason,
        newQuantity: result.newQuantity,
      },
    });
    return result;
  }

  async stockOut(
    tenantId: string,
    userId: string,
    input: StockOutInput,
  ): Promise<StockMovementResult> {
    const result = await this.movementService.stockOut(tenantId, userId, input);
    await this.auditLog.logAction({
      action: 'CREATE',
      resourceType: 'StockMovement',
      resourceId: result.movement.id,
      userId,
      tenantId,
      success: true,
      metadata: {
        type: 'out',
        productId: input.productId,
        storeId: input.storeId,
        quantity: input.quantity,
        reason: input.reason,
        newQuantity: result.newQuantity,
      },
    });
    // Best-effort post-commit notification when a new alert opened.
    if (result.alertsGenerated > 0) {
      void this.alertService.notifyForOpenItem(result.inventoryItem.id, tenantId).catch((err) => {
        this.logger.warn('inventory.stock_out.notify_failed', {
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      });
    }
    return result;
  }

  async adjust(
    tenantId: string,
    userId: string,
    input: AdjustStockInput,
  ): Promise<StockMovementResult> {
    const result = await this.movementService.adjust(tenantId, userId, input);
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: 'InventoryItem',
      resourceId: result.inventoryItem.id,
      userId,
      tenantId,
      success: true,
      metadata: {
        type: 'adjustment',
        productId: input.productId,
        storeId: input.storeId,
        newQuantity: input.newQuantity,
        reason: input.reason,
      },
    });
    return result;
  }

  /* ─────────────────── Reads ─────────────────── */

  async getCurrentStock(
    tenantId: string,
    productId: string,
    storeId: string,
  ): Promise<InventoryItem | null> {
    const item = await this.itemsRepo.findByProductAndStore(productId, storeId);
    if (!item) return null;
    if (item.tenantId !== tenantId) return null;
    return item;
  }

  async getStockByBatch(
    tenantId: string,
    productId: string,
    storeId: string,
  ): Promise<InventoryBatch[]> {
    const item = await this.itemsRepo.findByProductAndStore(productId, storeId);
    if (!item || item.tenantId !== tenantId) return [];
    return this.batchesRepo.findByInventoryItem(item.id);
  }

  async listStock(
    tenantId: string,
    filters: ListInventoryFilters,
  ): Promise<PaginatedResult<InventoryItem>> {
    return this.itemsRepo.findPaginatedScoped(tenantId, filters);
  }

  async getItemById(tenantId: string, id: string): Promise<InventoryItem | null> {
    return this.itemsRepo.findByIdInTenant(id, tenantId);
  }

  /* ─────────────────── Movement history ─────────────────── */

  async getMovementHistory(
    tenantId: string,
    filters: MovementHistoryFilters,
  ): Promise<PaginatedResult<StockMovement>> {
    return this.movementsRepo.findPaginatedScoped(tenantId, filters);
  }

  /* ─────────────────── Stats ─────────────────── */

  async getStoreSummary(tenantId: string, storeId: string): Promise<InventorySummary> {
    return this.aggregator.storeSummary(tenantId, storeId);
  }

  async getCategoryBreakdown(tenantId: string, storeId: string): Promise<CategoryBreakdownEntry[]> {
    return this.aggregator.categoryBreakdown(tenantId, storeId);
  }

  /* ─────────────────── Low stock ─────────────────── */

  async getLowStockAlerts(tenantId: string, storeId: string): Promise<LowStockAlert[]> {
    return this.alertService.listActiveForStore(tenantId, storeId);
  }

  async setLowStockRule(
    tenantId: string,
    userId: string,
    input: LowStockRuleInput,
  ): Promise<LowStockRule> {
    const rule = await this.alertService.setRule(tenantId, userId, input);
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: 'LowStockRule',
      resourceId: rule.id,
      userId,
      tenantId,
      success: true,
      metadata: {
        productId: input.productId ?? null,
        category: input.category ?? null,
        threshold: input.threshold,
        enabled: input.enabled !== false,
      },
    });
    return rule;
  }

  async listLowStockRules(tenantId: string, storeId: string): Promise<LowStockRule[]> {
    return this.alertService.listRules(tenantId, storeId);
  }

  async deleteLowStockRule(tenantId: string, userId: string, ruleId: string): Promise<void> {
    return this.alertService.deleteRule(tenantId, ruleId, userId);
  }

  /* ─────────────────── Stock counts ─────────────────── */

  async startStockCount(
    tenantId: string,
    userId: string,
    input: StartStockCountInput,
  ): Promise<StockCount> {
    return this.countService.start(tenantId, userId, input);
  }

  async recordCountLine(
    tenantId: string,
    userId: string,
    countId: string,
    input: RecordStockCountLineInput,
  ): Promise<StockCountLine> {
    return this.countService.recordLine(tenantId, countId, userId, input);
  }

  async listCountLines(tenantId: string, countId: string): Promise<StockCountLine[]> {
    return this.countService.listLines(tenantId, countId);
  }

  async completeStockCount(
    tenantId: string,
    userId: string,
    countId: string,
  ): Promise<StockCountResult> {
    return this.countService.complete(tenantId, countId, userId);
  }

  async cancelStockCount(
    tenantId: string,
    userId: string,
    countId: string,
    reason: string,
  ): Promise<StockCount> {
    return this.countService.cancel(tenantId, countId, userId, reason);
  }

  async getStockCount(tenantId: string, countId: string): Promise<StockCount> {
    return this.countService.findById(tenantId, countId);
  }

  async listStockCounts(tenantId: string, storeId: string): Promise<StockCount[]> {
    return this.countService.listForStore(tenantId, storeId);
  }

  /* ─────────────────── BE-26 GRN integration contract ─────────────────── */

  /**
   * Called by `GrnPostingService` (BE-26) once per posted line.
   * Forwards to `stockIn` with `reason='grn_post'` and threads the
   * GRN ids through `sourceType` / `sourceId` for traceability.
   *
   * Throws are propagated — GRN posting expects to roll back its own
   * transaction if inventory writes fail.
   */
  async applyInbound(req: InventoryMovementRequest): Promise<InventoryMovementResult> {
    const result = await this.stockIn(req.tenantId, req.actorId, {
      productId: req.productId,
      storeId: req.storeId,
      quantity: req.quantity,
      reason: req.source === 'grn' ? 'grn_post' : 'returned',
      batchNumber: req.batchNumber,
      expiryDate: req.expiryDate,
      unitCost: req.unitCost,
      sourceType: 'grn',
      sourceId: req.sourceId,
      notes: `GRN line ${req.sourceLineId}`,
    });
    return {
      inventoryItemId: result.inventoryItem.id,
      stockMovementId: result.movement.id,
      newQuantity: result.newQuantity,
    };
  }

  /**
   * Called by `GrnReversalService` (BE-26) per reversed line.
   * Forwards to `stockOut` with `reason='grn_reversal'`.
   */
  async applyOutbound(req: InventoryMovementRequest): Promise<InventoryMovementResult> {
    const result = await this.stockOut(req.tenantId, req.actorId, {
      productId: req.productId,
      storeId: req.storeId,
      quantity: req.quantity,
      reason: 'grn_reversal',
      batchNumber: req.batchNumber,
      sourceType: 'grn',
      sourceId: req.sourceId,
      notes: `GRN reversal line ${req.sourceLineId}`,
    });
    return {
      inventoryItemId: result.inventoryItem.id,
      stockMovementId: result.movement.id,
      newQuantity: result.newQuantity,
    };
  }
}
