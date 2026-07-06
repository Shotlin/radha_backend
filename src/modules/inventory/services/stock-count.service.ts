import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { StockCountLinesRepository } from '../repositories/stock-count-lines.repository';
import { StockCountsRepository } from '../repositories/stock-counts.repository';
import {
  RecordStockCountLineInput,
  StartStockCountInput,
  StockCount,
  StockCountLine,
  StockCountResult,
} from '../types/inventory.types';

import { StockMovementService } from './stock-movement.service';

/**
 * BE-27 — Physical stock count workflow.
 *
 * Lifecycle:
 *   start   → record line(s) → complete (variances → adjustments)
 *                            ↘ cancel (no adjustments)
 *
 * Completion is the only transition that touches `inventory_items` —
 * it emits one `stock_movements.adjustment` per non-zero variance via
 * the shared `StockMovementService.applyAdjustInTx`. Everything else
 * is local to the count tables.
 *
 * Concurrency: completion uses `updateStatusGuarded` so two reviewers
 * can't both flip "in_progress → completed". The recorded lines are
 * snapshotted at submit time (`systemQuantity` + `variance` are
 * persisted) so race conditions on a concurrent stock-out movement
 * don't change the historical truth of the count.
 */
@Injectable()
export class StockCountService {
  constructor(
    private readonly db: DbService,
    private readonly countsRepo: StockCountsRepository,
    private readonly linesRepo: StockCountLinesRepository,
    private readonly itemsRepo: InventoryItemsRepository,
    private readonly movementService: StockMovementService,
    private readonly auditLog: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  async start(tenantId: string, userId: string, input: StartStockCountInput): Promise<StockCount> {
    return this.db.transaction(async (tx) => {
      const now = input.startedAt ?? new Date();
      const created = await this.countsRepo.create(
        {
          tenantId,
          storeId: input.storeId,
          status: 'in_progress',
          startedAt: now,
          notes: input.notes ?? null,
          createdBy: userId,
          updatedBy: userId,
        },
        tx,
      );

      await this.auditLog.logAction({
        action: 'CREATE',
        resourceType: 'StockCount',
        resourceId: created.id,
        userId,
        tenantId,
        success: true,
        metadata: { storeId: input.storeId },
      });

      this.logger.info('inventory.stock_count.started', {
        countId: created.id,
        tenantId,
        storeId: input.storeId,
      });
      return created;
    });
  }

  async recordLine(
    tenantId: string,
    countId: string,
    userId: string,
    input: RecordStockCountLineInput,
  ): Promise<StockCountLine> {
    const count = await this.countsRepo.findByIdInTenant(countId, tenantId);
    if (!count) throw new DomainNotFoundException('StockCount', countId);
    if (count.status !== 'in_progress') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot add lines to a count in '${count.status}' state`,
      );
    }

    return this.db.transaction(async (tx) => {
      const item = await this.itemsRepo.findByProductAndStore(input.productId, count.storeId, tx);
      const systemQuantity = item?.quantity ?? 0;
      const variance = input.countedQuantity - systemQuantity;

      const line = await this.linesRepo.upsertForProduct(
        countId,
        input.productId,
        {
          stockCountId: countId,
          tenantId,
          storeId: count.storeId,
          productId: input.productId,
          systemQuantity,
          countedQuantity: input.countedQuantity,
          variance,
          notes: input.notes ?? null,
        },
        {
          systemQuantity,
          countedQuantity: input.countedQuantity,
          variance,
          notes: input.notes ?? null,
        },
        tx,
      );

      this.logger.info('inventory.stock_count.line_recorded', {
        countId,
        productId: input.productId,
        systemQuantity,
        countedQuantity: input.countedQuantity,
        variance,
      });
      // Suppress unused-warning for userId; kept on the signature so
      // the controller can pass through the actor for audit hooks
      // when the caller graduates to per-line audit logs.
      void userId;
      return line;
    });
  }

  async listLines(tenantId: string, countId: string): Promise<StockCountLine[]> {
    const count = await this.countsRepo.findByIdInTenant(countId, tenantId);
    if (!count) throw new DomainNotFoundException('StockCount', countId);
    return this.linesRepo.findByCount(countId);
  }

  /**
   * Complete a count: read all lines, emit adjustment movements for
   * non-zero variances, flip status to 'completed' under the optimistic
   * guard. Returns aggregate stats.
   */
  async complete(tenantId: string, countId: string, userId: string): Promise<StockCountResult> {
    const count = await this.countsRepo.findByIdInTenant(countId, tenantId);
    if (!count) throw new DomainNotFoundException('StockCount', countId);
    if (count.status === 'completed') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Stock count is already completed',
      );
    }
    if (count.status === 'cancelled') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot complete a cancelled stock count',
      );
    }

    return this.db.transaction(async (tx) => {
      const lines = await this.linesRepo.findByCount(countId, tx);

      let variances = 0;
      let totalVarianceQuantity = 0;
      let adjustmentsCreated = 0;

      for (const line of lines) {
        if (line.variance === 0) continue;
        variances += 1;
        totalVarianceQuantity += Math.abs(line.variance);

        const movementResult = await this.movementService.applyAdjustInTx(
          tenantId,
          userId,
          {
            productId: line.productId,
            storeId: count.storeId,
            newQuantity: line.countedQuantity,
            reason: 'count_adjustment',
            notes: `Stock count ${countId} variance ${line.variance >= 0 ? '+' : ''}${line.variance}`,
          },
          tx,
        );
        adjustmentsCreated += 1;

        await this.linesRepo.update(
          line.id,
          { adjustmentMovementId: movementResult.movement.id },
          tx,
        );
      }

      const updated = await this.countsRepo.updateStatusGuarded(
        countId,
        ['in_progress'],
        {
          status: 'completed',
          completedAt: new Date(),
          totalProducts: lines.length,
          variances,
          totalVarianceQuantity,
          adjustmentsCreated,
          updatedBy: userId,
        },
        tx,
      );
      if (!updated) {
        throw new BusinessException(
          ErrorCode.CONCURRENT_MODIFICATION,
          'Stock count was completed by another session',
        );
      }

      await this.auditLog.logAction({
        action: 'UPDATE',
        resourceType: 'StockCount',
        resourceId: countId,
        userId,
        tenantId,
        success: true,
        metadata: {
          transition: 'complete',
          totalProducts: lines.length,
          variances,
          adjustmentsCreated,
        },
      });

      this.logger.info('inventory.stock_count.completed', {
        countId,
        tenantId,
        totalProducts: lines.length,
        variances,
        adjustmentsCreated,
      });

      return {
        countId,
        totalProducts: lines.length,
        variances,
        totalVarianceQuantity,
        adjustmentsCreated,
      };
    });
  }

  async cancel(
    tenantId: string,
    countId: string,
    userId: string,
    reason: string,
  ): Promise<StockCount> {
    const count = await this.countsRepo.findByIdInTenant(countId, tenantId);
    if (!count) throw new DomainNotFoundException('StockCount', countId);
    if (count.status !== 'in_progress') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot cancel a count in '${count.status}' state`,
      );
    }

    return this.db.transaction(async (tx) => {
      const updated = await this.countsRepo.updateStatusGuarded(
        countId,
        ['in_progress'],
        {
          status: 'cancelled',
          cancelledAt: new Date(),
          notes: reason,
          updatedBy: userId,
        },
        tx,
      );
      if (!updated) {
        throw new BusinessException(
          ErrorCode.CONCURRENT_MODIFICATION,
          'Stock count was modified concurrently',
        );
      }
      await this.auditLog.logAction({
        action: 'UPDATE',
        resourceType: 'StockCount',
        resourceId: countId,
        userId,
        tenantId,
        success: true,
        metadata: { transition: 'cancel', reason },
      });
      return updated;
    });
  }

  async findById(tenantId: string, countId: string): Promise<StockCount> {
    const count = await this.countsRepo.findByIdInTenant(countId, tenantId);
    if (!count) throw new DomainNotFoundException('StockCount', countId);
    return count;
  }

  async listForStore(tenantId: string, storeId: string): Promise<StockCount[]> {
    return this.countsRepo.listForStore(tenantId, storeId);
  }
}
