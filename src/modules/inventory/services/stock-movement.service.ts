import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';

import { InventoryBatchesRepository } from '../repositories/inventory-batches.repository';
import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { StockMovementsRepository } from '../repositories/stock-movements.repository';
import {
  AdjustStockInput,
  InventoryBatch,
  InventoryItem,
  StockInInput,
  StockMovement,
  StockMovementResult,
  StockOutInput,
} from '../types/inventory.types';

import { LowStockAlertService } from './low-stock-alert.service';

/**
 * BE-27 — Atomic stock movement orchestration.
 *
 * The single chokepoint that mutates `inventory_items` /
 * `inventory_batches` / `stock_movements`. Every public method opens
 * its own transaction so the three writes commit together (or
 * rollback together).
 *
 * Concurrency safety:
 *   - serializable transactions for stock-out so the
 *     "available stock" check + deduction don't race,
 *   - read-committed for stock-in (the upsert is idempotent),
 *   - explicit guard via "throw if available < requested" inside the
 *     transaction so the storage layer never carries negative stock.
 *
 * Low-stock alerts are evaluated AFTER the inventory write inside
 * the same transaction so the alert state is consistent with the
 * quantity. Notification dispatch (push/email) is intentionally
 * delegated to `LowStockAlertService.notifyForOpenItem` and runs
 * post-commit (best-effort).
 */
@Injectable()
export class StockMovementService {
  constructor(
    private readonly db: DbService,
    private readonly itemsRepo: InventoryItemsRepository,
    private readonly batchesRepo: InventoryBatchesRepository,
    private readonly movementsRepo: StockMovementsRepository,
    private readonly alertService: LowStockAlertService,
  ) {}

  /* ─────────────────── Stock In ─────────────────── */

  async stockIn(
    tenantId: string,
    userId: string,
    input: StockInInput,
  ): Promise<StockMovementResult> {
    return this.db.transaction(async (tx) => this.applyStockInInTx(tenantId, userId, input, tx));
  }

  /**
   * Internal stock-in routine. Exposed so `InventoryService.applyInbound`
   * (the GRN integration entry point) can chain into it from another
   * caller's transaction context if needed.
   */
  async applyStockInInTx(
    tenantId: string,
    userId: string,
    input: StockInInput,
    tx: Transaction,
  ): Promise<StockMovementResult> {
    if (input.quantity <= 0) {
      throw new BusinessException(
        ErrorCode.VALUE_OUT_OF_RANGE,
        'Stock-in quantity must be positive',
      );
    }

    const existing = await this.itemsRepo.findByProductAndStore(input.productId, input.storeId, tx);
    // `findByProductAndStore` is keyed on (product, store) only — NOT tenant —
    // so an existing row could belong to another tenant if a storeId ever
    // resolved outside the caller's tenant. Fail closed rather than writing
    // across tenants, matching applyStockOutInTx / applyAdjustInTx. A genuinely
    // new (product, store) for this tenant still hits the create path below.
    if (existing && existing.tenantId !== tenantId) {
      throw new DomainNotFoundException('InventoryItem');
    }
    const quantityBefore = existing?.quantity ?? 0;
    const quantityAfter = quantityBefore + input.quantity;

    let item: InventoryItem;
    if (!existing) {
      item = await this.itemsRepo.create(
        {
          tenantId,
          storeId: input.storeId,
          productId: input.productId,
          quantity: input.quantity,
          reservedQuantity: 0,
          availableQuantity: input.quantity,
          totalIn: input.quantity,
          totalOut: 0,
          lastInAt: new Date(),
          lastMovementAt: new Date(),
          createdBy: userId,
          updatedBy: userId,
        },
        tx,
      );
    } else {
      item = await this.itemsRepo.update(
        existing.id,
        {
          quantity: quantityAfter,
          availableQuantity: quantityAfter - existing.reservedQuantity,
          totalIn: existing.totalIn + input.quantity,
          lastInAt: new Date(),
          lastMovementAt: new Date(),
          updatedBy: userId,
        },
        tx,
      );
    }

    // Upsert the corresponding batch.
    const batch = await this.upsertBatch(tenantId, input, item.id, tx);

    const movement = await this.movementsRepo.create(
      {
        tenantId,
        storeId: input.storeId,
        productId: input.productId,
        inventoryItemId: item.id,
        type: 'in',
        reason: input.reason,
        quantity: input.quantity,
        quantityBefore,
        quantityAfter,
        batchNumber: input.batchNumber ?? null,
        inventoryBatchId: batch?.id ?? null,
        sourceType: input.sourceType ?? this.reasonToSourceType(input.reason),
        sourceId: input.sourceId ?? this.parseReference(input.reference),
        unitCost: input.unitCost !== undefined ? input.unitCost.toString() : null,
        totalCost:
          input.unitCost !== undefined ? (input.unitCost * input.quantity).toString() : null,
        userId,
        notes: input.notes ?? null,
      },
      tx,
    );

    // Recompute low-stock state — stock-in usually resolves an alert.
    const alertsGenerated = await this.alertService.checkAndCreate(item, tx);

    return {
      movement,
      inventoryItem: item,
      newQuantity: quantityAfter,
      alertsGenerated,
    };
  }

  /* ─────────────────── Stock Out ─────────────────── */

  async stockOut(
    tenantId: string,
    userId: string,
    input: StockOutInput,
  ): Promise<StockMovementResult> {
    if (input.quantity <= 0) {
      throw new BusinessException(
        ErrorCode.VALUE_OUT_OF_RANGE,
        'Stock-out quantity must be positive',
      );
    }
    return this.db.transaction(async (tx) => this.applyStockOutInTx(tenantId, userId, input, tx), {
      isolationLevel: 'serializable',
    });
  }

  async applyStockOutInTx(
    tenantId: string,
    userId: string,
    input: StockOutInput,
    tx: Transaction,
  ): Promise<StockMovementResult> {
    const existing = await this.itemsRepo.findByProductAndStore(input.productId, input.storeId, tx);
    if (!existing) {
      throw new DomainNotFoundException('InventoryItem');
    }
    if (existing.tenantId !== tenantId) {
      throw new DomainNotFoundException('InventoryItem');
    }
    if (existing.availableQuantity < input.quantity) {
      throw new BusinessException(
        ErrorCode.INSUFFICIENT_STOCK,
        `Available: ${existing.availableQuantity}, requested: ${input.quantity}`,
      );
    }

    const quantityBefore = existing.quantity;
    const quantityAfter = quantityBefore - input.quantity;

    let firstBatchUsed: InventoryBatch | undefined;
    let primaryBatchNumber: string | null = input.batchNumber ?? null;

    if (input.batchNumber) {
      // Pinned batch deduction.
      const batch = await this.batchesRepo.findByBatchNumber(
        input.productId,
        input.storeId,
        input.batchNumber,
        tx,
      );
      if (!batch || batch.quantity < input.quantity) {
        throw new BusinessException(
          ErrorCode.INSUFFICIENT_STOCK,
          `Insufficient stock in batch ${input.batchNumber}`,
        );
      }
      await this.batchesRepo.update(batch.id, { quantity: batch.quantity - input.quantity }, tx);
      firstBatchUsed = batch;
    } else {
      // FIFO deduction — oldest expiry first.
      const batches = await this.batchesRepo.findFifoBatches(input.productId, input.storeId, tx);
      let remaining = input.quantity;
      for (const batch of batches) {
        if (remaining === 0) break;
        const take = Math.min(batch.quantity, remaining);
        await this.batchesRepo.update(batch.id, { quantity: batch.quantity - take }, tx);
        remaining -= take;
        if (!firstBatchUsed) {
          firstBatchUsed = batch;
          primaryBatchNumber = batch.batchNumber;
        }
      }
      if (remaining > 0) {
        // Defensive: availableQuantity check above should preclude
        // this, but a desync between item.quantity and the sum of
        // batches would surface here. Refuse the operation rather
        // than write an inconsistent movement.
        throw new BusinessException(
          ErrorCode.INSUFFICIENT_STOCK,
          'Available quantity is desynchronised with batch totals',
        );
      }
    }

    const item = await this.itemsRepo.update(
      existing.id,
      {
        quantity: quantityAfter,
        availableQuantity: quantityAfter - existing.reservedQuantity,
        totalOut: existing.totalOut + input.quantity,
        lastOutAt: new Date(),
        lastMovementAt: new Date(),
        updatedBy: userId,
      },
      tx,
    );

    const movement = await this.movementsRepo.create(
      {
        tenantId,
        storeId: input.storeId,
        productId: input.productId,
        inventoryItemId: item.id,
        type: 'out',
        reason: input.reason,
        quantity: -input.quantity,
        quantityBefore,
        quantityAfter,
        batchNumber: primaryBatchNumber,
        inventoryBatchId: firstBatchUsed?.id ?? null,
        sourceType: input.sourceType ?? this.reasonToSourceType(input.reason),
        sourceId: input.sourceId ?? null,
        userId,
        notes: input.notes ?? null,
      },
      tx,
    );

    const alertsGenerated = await this.alertService.checkAndCreate(item, tx);

    return {
      movement,
      inventoryItem: item,
      newQuantity: quantityAfter,
      alertsGenerated,
    };
  }

  /* ─────────────────── Adjust ─────────────────── */

  async adjust(
    tenantId: string,
    userId: string,
    input: AdjustStockInput,
  ): Promise<StockMovementResult> {
    return this.db.transaction(async (tx) => this.applyAdjustInTx(tenantId, userId, input, tx));
  }

  async applyAdjustInTx(
    tenantId: string,
    userId: string,
    input: AdjustStockInput,
    tx: Transaction,
  ): Promise<StockMovementResult> {
    const existing = await this.itemsRepo.findByProductAndStore(input.productId, input.storeId, tx);
    if (!existing) {
      throw new DomainNotFoundException('InventoryItem');
    }
    if (existing.tenantId !== tenantId) {
      throw new DomainNotFoundException('InventoryItem');
    }
    if (input.newQuantity < 0) {
      throw new BusinessException(ErrorCode.VALUE_OUT_OF_RANGE, 'newQuantity must be non-negative');
    }

    const quantityBefore = existing.quantity;
    const delta = input.newQuantity - quantityBefore;

    const item = await this.itemsRepo.update(
      existing.id,
      {
        quantity: input.newQuantity,
        availableQuantity: input.newQuantity - existing.reservedQuantity,
        lastMovementAt: new Date(),
        updatedBy: userId,
      },
      tx,
    );

    const movement = await this.movementsRepo.create(
      {
        tenantId,
        storeId: input.storeId,
        productId: input.productId,
        inventoryItemId: item.id,
        type: 'adjustment',
        reason: input.reason,
        quantity: delta,
        quantityBefore,
        quantityAfter: input.newQuantity,
        sourceType: this.reasonToSourceType(input.reason),
        userId,
        notes: input.notes ?? null,
      },
      tx,
    );

    const alertsGenerated = await this.alertService.checkAndCreate(item, tx);

    return {
      movement,
      inventoryItem: item,
      newQuantity: input.newQuantity,
      alertsGenerated,
    };
  }

  /* ─────────────────── Helpers ─────────────────── */

  /**
   * Adds a batch row for a stock-in. When a `batchNumber` is given,
   * the named batch is upserted. When no batch number is supplied,
   * a new unbatched row is created — multiple unbatched rows per
   * (product, store) are allowed and consumed FIFO by `receivedAt`.
   */
  private async upsertBatch(
    tenantId: string,
    input: StockInInput,
    inventoryItemId: string,
    tx: Transaction,
  ): Promise<InventoryBatch | undefined> {
    if (input.batchNumber) {
      const existing = await this.batchesRepo.findByBatchNumber(
        input.productId,
        input.storeId,
        input.batchNumber,
        tx,
      );
      if (existing) {
        return this.batchesRepo.update(
          existing.id,
          {
            quantity: existing.quantity + input.quantity,
            expiryDate: input.expiryDate ?? existing.expiryDate ?? null,
            manufactureDate: input.manufactureDate ?? existing.manufactureDate ?? null,
          },
          tx,
        );
      }
      return this.batchesRepo.create(
        {
          inventoryItemId,
          tenantId,
          storeId: input.storeId,
          productId: input.productId,
          batchNumber: input.batchNumber,
          quantity: input.quantity,
          expiryDate: input.expiryDate ?? null,
          manufactureDate: input.manufactureDate ?? null,
          sourceType: input.sourceType ?? this.reasonToSourceType(input.reason),
          sourceId: input.sourceId ?? this.parseReference(input.reference),
        },
        tx,
      );
    }

    return this.batchesRepo.create(
      {
        inventoryItemId,
        tenantId,
        storeId: input.storeId,
        productId: input.productId,
        batchNumber: null,
        quantity: input.quantity,
        expiryDate: input.expiryDate ?? null,
        manufactureDate: input.manufactureDate ?? null,
        sourceType: input.sourceType ?? this.reasonToSourceType(input.reason),
        sourceId: input.sourceId ?? this.parseReference(input.reference),
      },
      tx,
    );
  }

  private reasonToSourceType(reason: string): string {
    const map: Record<string, string> = {
      grn_post: 'grn',
      grn_reversal: 'grn',
      manual_in: 'manual',
      sale: 'sale',
      expired: 'expiry',
      damaged: 'damage',
      returned: 'return',
      theft: 'shrinkage',
      count_adjustment: 'count',
      correction: 'manual',
    };
    return map[reason] ?? 'other';
  }

  private parseReference(ref?: string): string | null {
    if (!ref) return null;
    if (ref.includes(':')) {
      const after = ref.split(':')[1];
      return after && after.length > 0 ? after : null;
    }
    return ref;
  }

  /** Returns the most recent movement for a (product, store). Used by
   *  the controller to surface the "last activity" widget. */
  async getLatestMovement(
    tenantId: string,
    productId: string,
    storeId: string,
  ): Promise<StockMovement | null> {
    const list = await this.movementsRepo.listForProduct(tenantId, productId, storeId, 1);
    return list[0] ?? null;
  }
}
