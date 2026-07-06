import { Inject, Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { GrnEventsRepository } from '../repositories/grn-events.repository';
import { GrnHeadersRepository } from '../repositories/grn-headers.repository';
import { GrnItemsRepository } from '../repositories/grn-items.repository';
import {
  IInventoryService,
  INVENTORY_SERVICE_TOKEN,
  ISupplierPerformanceService,
  ReverseResult,
  SUPPLIER_PERFORMANCE_TOKEN,
} from '../types/grn.types';

/**
 * BE-26 — GRN reversal.
 *
 * Idempotent rollback of a posted GRN:
 *   - flips status `posted → reversed` via the optimistic state
 *     guard (so a second reverse call returns a clean error rather
 *     than double-applying outbound movements),
 *   - emits an outbound inventory movement per line item (the
 *     injected `IInventoryService` decides whether that's a real
 *     stock decrement or a no-op stub),
 *   - signals the supplier-performance service to undo any score
 *     contribution from this GRN — best-effort outside the
 *     transaction, just like posting,
 *   - never deletes the original rows. The history is intact: the
 *     reversed GRN keeps its `posted_at`, `posted_by`, and items;
 *     `reversed_at` / `reversed_by` / `reversal_reason` are layered
 *     on top.
 */
@Injectable()
export class GrnReversalService {
  constructor(
    private readonly db: DbService,
    private readonly headersRepo: GrnHeadersRepository,
    private readonly itemsRepo: GrnItemsRepository,
    private readonly eventsRepo: GrnEventsRepository,
    private readonly auditLog: AuditLogService,
    private readonly logger: LoggerService,
    @Inject(INVENTORY_SERVICE_TOKEN)
    private readonly inventory: IInventoryService,
    @Inject(SUPPLIER_PERFORMANCE_TOKEN)
    private readonly supplierPerf: ISupplierPerformanceService,
  ) {}

  async reverse(
    grnId: string,
    tenantId: string,
    userId: string,
    reason: string,
  ): Promise<ReverseResult> {
    const grn = await this.headersRepo.findByIdInTenant(grnId, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', grnId);

    if (grn.status === 'reversed') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'GRN has already been reversed',
      );
    }
    if (grn.status !== 'posted') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot reverse GRN in '${grn.status}' state — only posted GRNs can be reversed`,
      );
    }

    const result = await this.db.transaction(
      async (tx) => this.reverseInTransaction(grn.id, tenantId, userId, reason, tx),
      { isolationLevel: 'serializable' },
    );

    void this.supplierPerf.reverseMetrics(grn.tenantId, grn.supplierId, grn.id).catch((err) => {
      this.logger.warn('grn.supplier_performance.reverse_failed', {
        grnId: grn.id,
        supplierId: grn.supplierId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    });

    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: 'GrnPosting',
      resourceId: grnId,
      userId,
      tenantId,
      success: true,
      metadata: {
        transition: 'reverse',
        itemsReverted: result.inventoryReverted,
        expiryRecordsReverted: result.expiryRecordsReverted,
        reason,
      },
    });

    this.logger.info('grn.reversed', {
      grnId,
      tenantId,
      itemsReverted: result.inventoryReverted,
    });

    return result;
  }

  private async reverseInTransaction(
    grnId: string,
    tenantId: string,
    userId: string,
    reason: string,
    tx: Transaction,
  ): Promise<ReverseResult> {
    const items = await this.itemsRepo.findByGrn(grnId, tx);

    let inventoryReverted = 0;
    let expiryRecordsReverted = 0;

    for (const item of items) {
      if (!item.productId) {
        // Line was never posted (no productId resolved). Skip —
        // nothing to reverse.
        continue;
      }
      await this.inventory.applyOutbound({
        tenantId,
        storeId: item.storeId,
        productId: item.productId,
        quantity: item.quantity,
        batchNumber: item.batchNumber ?? undefined,
        expiryDate: item.expiryDate ?? undefined,
        unitCost: item.unitPrice ? Number(item.unitPrice) : undefined,
        source: 'grn_reversal',
        sourceId: grnId,
        sourceLineId: item.id,
        actorId: userId,
      });
      inventoryReverted++;
      if (item.expiryRecordId) expiryRecordsReverted++;
    }

    const reversedAt = new Date();
    const updated = await this.headersRepo.updateStatusGuarded(
      grnId,
      ['posted'],
      {
        status: 'reversed',
        reversedAt,
        reversedBy: userId,
        reversalReason: reason,
      },
      tx,
    );
    if (!updated) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'GRN was reversed by another session',
      );
    }

    await this.eventsRepo.create(
      {
        grnId,
        tenantId,
        type: 'reversed',
        actorId: userId,
        notes: reason,
        metadata: {
          itemsReverted: inventoryReverted,
          expiryRecordsReverted,
        },
      },
      tx,
    );

    return {
      grn: updated,
      reversedAt,
      inventoryReverted,
      expiryRecordsReverted,
    };
  }
}
