import { Inject, Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { ExpiryService } from '@/modules/expiry/expiry.service';
import { ProductsRepository } from '@/modules/products/products.repository';
import { AuditLogService } from '@/observability/audit-log.service';

import { GrnEventsRepository } from '../repositories/grn-events.repository';
import { GrnHeadersRepository } from '../repositories/grn-headers.repository';
import { GrnItemsRepository } from '../repositories/grn-items.repository';
import {
  IInventoryService,
  INVENTORY_SERVICE_TOKEN,
  ISupplierPerformanceService,
  InventoryUpdate,
  PostResult,
  SUPPLIER_PERFORMANCE_TOKEN,
} from '../types/grn.types';
import { GrnValidationService } from './grn-validation.service';

/**
 * BE-26 — Atomic posting.
 *
 * Posting is the single transition where GRN data leaves draft state
 * and becomes visible to inventory + expiry tracking + vendor
 * scorecards. Everything must succeed together or rollback.
 *
 * Sequence inside a serializable transaction:
 *   1. State guard via `updateStatusGuarded` — flips status from
 *      `draft|pending_review` to `posted`. Returns null if another
 *      session beat us to it; we surface a clean `GRN_ALREADY_POSTED`.
 *   2. For each line item:
 *        a. Resolve product (auto-create with status=pending_review
 *           when EAN isn't in the catalog).
 *        b. Apply the inventory inbound movement via the injected
 *           `IInventoryService`. The stub used until BE-27 lands
 *           records intent only.
 *        c. Create an expiry_records row when expiryDate is present.
 *        d. Patch the line with the resolved productId + linked ids.
 *   3. Update header counters (`shortShelfLifeCount`,
 *      `minExpiryRemainingDays`).
 *   4. Append a `posted` grn_events row.
 *   5. Audit-log the action.
 *   6. After commit (best-effort, non-blocking): publish supplier
 *      performance metrics. Done outside the transaction so a slow
 *      / flaky downstream never holds the GRN row lock open.
 */
@Injectable()
export class GrnPostingService {
  constructor(
    private readonly db: DbService,
    private readonly headersRepo: GrnHeadersRepository,
    private readonly itemsRepo: GrnItemsRepository,
    private readonly eventsRepo: GrnEventsRepository,
    private readonly validator: GrnValidationService,
    private readonly productsRepo: ProductsRepository,
    private readonly expiryService: ExpiryService,
    private readonly auditLog: AuditLogService,
    private readonly logger: LoggerService,
    @Inject(INVENTORY_SERVICE_TOKEN)
    private readonly inventory: IInventoryService,
    @Inject(SUPPLIER_PERFORMANCE_TOKEN)
    private readonly supplierPerf: ISupplierPerformanceService,
  ) {}

  async post(grnId: string, tenantId: string, userId: string): Promise<PostResult> {
    // 1. Read-time validation. Ensures we surface a clean error before
    //    we open a write transaction.
    const grn = await this.headersRepo.findByIdInTenant(grnId, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', grnId);

    if (grn.status === 'posted') {
      throw new BusinessException(ErrorCode.GRN_ALREADY_POSTED, 'GRN has already been posted');
    }
    if (grn.status === 'cancelled' || grn.status === 'reversed') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot post GRN in '${grn.status}' state`,
      );
    }

    const validation = await this.validator.validate(grnId, tenantId);
    if (!validation.valid) {
      throw new BusinessException(ErrorCode.VALIDATION_ERROR, 'GRN validation failed', {
        metadata: { errors: validation.errors },
      });
    }

    // 2. Atomic write — serializable so concurrent posts on the same
    //    GRN can't race past the state guard.
    const result = await this.db.transaction(
      async (tx) => this.postInTransaction(grn.id, tenantId, userId, tx),
      { isolationLevel: 'serializable' },
    );

    // 3. Best-effort post-commit hooks. Failures are logged but do
    //    NOT roll back the transaction (already committed) — the
    //    handoff doc flags the eventual-consistency window for these.
    void this.publishSupplierMetrics(result).catch((err) => {
      this.logger.warn('grn.supplier_performance.publish_failed', {
        grnId: result.grn.id,
        supplierId: result.grn.supplierId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    });

    await this.auditLog.logAction({
      action: 'CREATE',
      resourceType: 'GrnPosting',
      resourceId: grnId,
      userId,
      tenantId,
      success: true,
      metadata: {
        transition: 'post',
        itemsPosted: result.inventoryUpdates.length,
        expiryRecordsCreated: result.expiryRecordsCreated,
        warnings: validation.warnings.length,
      },
    });

    this.logger.info('grn.posted', {
      grnId: result.grn.id,
      tenantId,
      itemsPosted: result.inventoryUpdates.length,
      shortShelfLifeCount: result.grn.shortShelfLifeCount,
    });

    return result;
  }

  /* ─────────────────── Internals ─────────────────── */

  private async postInTransaction(
    grnId: string,
    tenantId: string,
    userId: string,
    tx: Transaction,
  ): Promise<PostResult> {
    const items = await this.itemsRepo.findByGrn(grnId, tx);
    if (items.length === 0) {
      throw new BusinessException(ErrorCode.VALIDATION_ERROR, 'Cannot post GRN with no items');
    }

    let minExpiryDays: number | null = null;
    let shortShelfLifeCount = 0;
    let expiryRecordsCreated = 0;
    const inventoryUpdates: InventoryUpdate[] = [];

    for (const item of items) {
      const resolvedProductId = await this.resolveProduct(
        tenantId,
        userId,
        item.ean,
        item.productId,
        item.productNameSnapshot,
        tx,
      );

      // Inventory inbound movement. The injected service may be the
      // BE-27 implementation or the in-process stub.
      const inv = await this.inventory.applyInbound({
        tenantId,
        storeId: item.storeId,
        productId: resolvedProductId,
        quantity: item.quantity,
        batchNumber: item.batchNumber ?? undefined,
        expiryDate: item.expiryDate ?? undefined,
        unitCost: item.unitPrice ? Number(item.unitPrice) : undefined,
        source: 'grn',
        sourceId: grnId,
        sourceLineId: item.id,
        actorId: userId,
      });

      // Expiry tracking — only when we have a date. BE-18 owns the
      // alert generation side-effect; we just register the record.
      let expiryRecordId: string | undefined;
      let daysRemaining: number | null = null;
      if (item.expiryDate) {
        const expiryRecord = await this.expiryService.createRecord(tenantId, userId, {
          productId: resolvedProductId,
          storeId: item.storeId,
          expiryDate: item.expiryDate,
          manufactureDate: item.manufactureDate ?? undefined,
          batchNumber: item.batchNumber ?? undefined,
          quantity: item.quantity,
          source: 'grn',
          sourceId: item.id,
          notes: item.notes ?? undefined,
        });
        expiryRecordId = expiryRecord.id;
        expiryRecordsCreated++;

        daysRemaining = expiryRecord.daysRemaining;
        if (daysRemaining !== null) {
          if (minExpiryDays === null || daysRemaining < minExpiryDays) {
            minExpiryDays = daysRemaining;
          }
          if (daysRemaining < GrnValidationService.SHORT_SHELF_LIFE_DAYS) {
            shortShelfLifeCount++;
          }
        }
      }

      // Patch the line with linkages so downstream BE-27 reports can
      // join cleanly without recomputing.
      await this.itemsRepo.update(
        item.id,
        {
          productId: resolvedProductId,
          expiryRecordId,
          inventoryItemId: inv.inventoryItemId,
          stockMovementId: inv.stockMovementId,
          expiryRemainingDays: daysRemaining ?? undefined,
        },
        tx,
      );

      inventoryUpdates.push({
        productId: resolvedProductId,
        storeId: item.storeId,
        batchNumber: item.batchNumber ?? undefined,
        quantityAdded: item.quantity,
        newTotal: inv.newQuantity,
      });
    }

    // State guard + counter refresh in one update. If another session
    // already posted, this returns null.
    const postedAt = new Date();
    const updated = await this.headersRepo.updateStatusGuarded(
      grnId,
      ['draft', 'pending_review'],
      {
        status: 'posted',
        postedAt,
        postedBy: userId,
        minExpiryRemainingDays: minExpiryDays,
        shortShelfLifeCount,
      },
      tx,
    );
    if (!updated) {
      throw new BusinessException(
        ErrorCode.GRN_ALREADY_POSTED,
        'GRN was posted by another session',
      );
    }

    await this.eventsRepo.create(
      {
        grnId,
        tenantId,
        type: 'posted',
        actorId: userId,
        notes: 'GRN posted to inventory',
        metadata: {
          totalItems: items.length,
          minExpiryDays,
          shortShelfLifeCount,
          expiryRecordsCreated,
        },
      },
      tx,
    );

    return {
      grn: updated,
      inventoryUpdates,
      expiryRecordsCreated,
      alertsGenerated: 0, // expiry alerts are emitted internally by ExpiryService
    };
  }

  /**
   * Resolve the product id for a line item.
   *
   * - If the line already carries `productId`, trust it.
   * - Otherwise look up by EAN + tenant scope. Use the visible
   *   row (tenant-private wins, then global).
   * - Otherwise auto-create a tenant-private product with
   *   status=pending_review so the manager can confirm later.
   */
  private async resolveProduct(
    tenantId: string,
    userId: string,
    ean: string,
    existingProductId: string | null,
    nameSnapshot: string | null,
    tx: Transaction,
  ): Promise<string> {
    if (existingProductId) return existingProductId;

    const found = await this.productsRepo.findVisibleByEan(ean, tenantId);
    if (found) return found.id;

    const created = await this.productsRepo.create(
      {
        tenantId,
        ean,
        name: nameSnapshot ?? `Product ${ean}`,
        status: 'pending_review',
        dataSource: 'grn',
        createdBy: userId,
      },
      tx,
    );
    return created.id;
  }

  /**
   * Best-effort vendor scorecard update. Runs outside the GRN
   * transaction — the GRN is already posted by the time we get here.
   * BE-25 and BE-30 own the analytics consumption.
   */
  private async publishSupplierMetrics(result: PostResult): Promise<void> {
    const grn = result.grn;
    const orderTime = grn.orderDate ? grn.orderDate.getTime() : null;
    const inwardTime = grn.inwardDate.getTime();
    const deliveryDays =
      orderTime !== null ? Math.max(0, Math.floor((inwardTime - orderTime) / 86_400_000)) : -1;

    await this.supplierPerf.updateMetrics(grn.tenantId, grn.supplierId, {
      grnId: grn.id,
      deliveryDays,
      expiryRemainingDays: grn.minExpiryRemainingDays ?? 9999,
      shortShelfLife: (grn.shortShelfLifeCount ?? 0) > 0,
      amount: grn.totalAmount ? Number(grn.totalAmount) : undefined,
      postedAt: grn.postedAt ?? new Date(),
    });
  }
}
