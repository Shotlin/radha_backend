import { Inject, Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import type { PaginatedResult } from '@/db/repositories/base.repository.types';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  CreateGrnDto,
  GrnItemDto,
  GrnStatsQueryDto,
  ListGrnsQueryDto,
  UpdateGrnDto,
  UpdateGrnItemDto,
} from './dto/grn.dto';
import { GrnEventsRepository } from './repositories/grn-events.repository';
import { GrnHeadersRepository } from './repositories/grn-headers.repository';
import { GrnItemsRepository } from './repositories/grn-items.repository';
import { GrnPostingService } from './services/grn-posting.service';
import { GrnReversalService } from './services/grn-reversal.service';
import { GrnValidationService } from './services/grn-validation.service';
import {
  Grn,
  GrnItem,
  GrnStats,
  GrnWithDetails,
  ISupplierLookupService,
  PostResult,
  ReverseResult,
  SUPPLIER_LOOKUP_TOKEN,
  ValidationResult,
} from './types/grn.types';
import { GrnNumberGenerator } from './utils/grn-number-generator.utils';

/**
 * BE-26 — Top-level GRN orchestrator.
 *
 *   Draft / pending_review CRUD
 *   Item add / update / remove (only on non-posted GRNs)
 *   Workflow: validate, post, cancel, reverse
 *   Listings: tenant-scoped paginated, supplier-scoped, stats
 *
 * Posting and reversal are delegated to dedicated services so this
 * file stays focused on the read paths and the simpler state
 * transitions. The transactional boundary for create/update is
 * managed here; posting and reversal own their own transactions.
 */
@Injectable()
export class GrnService {
  constructor(
    private readonly db: DbService,
    private readonly headersRepo: GrnHeadersRepository,
    private readonly itemsRepo: GrnItemsRepository,
    private readonly eventsRepo: GrnEventsRepository,
    private readonly postingService: GrnPostingService,
    private readonly reversalService: GrnReversalService,
    private readonly validationService: GrnValidationService,
    private readonly numberGenerator: GrnNumberGenerator,
    private readonly auditLog: AuditLogService,
    private readonly logger: LoggerService,
    @Inject(SUPPLIER_LOOKUP_TOKEN)
    private readonly supplierLookup: ISupplierLookupService,
  ) {}

  /* ─────────────────── Draft management ─────────────────── */

  async createDraft(tenantId: string, userId: string, dto: CreateGrnDto): Promise<Grn> {
    // Verify supplier exists, is in this tenant, and is active.
    const supplier = await this.supplierLookup.findById(dto.supplierId);
    if (!supplier) throw new DomainNotFoundException('Supplier', dto.supplierId);
    if (supplier.tenantId !== tenantId) {
      // Mirror the products module convention: cross-tenant resources
      // surface as 404, not 403, to avoid leaking existence.
      throw new DomainNotFoundException('Supplier', dto.supplierId);
    }
    if (supplier.status === 'blacklisted') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot create GRN for blacklisted supplier',
      );
    }
    if (supplier.status !== 'active') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Supplier is in '${supplier.status}' state`,
      );
    }

    // Pre-flight duplicate-invoice check. The DB unique index is the
    // hard guarantee, but reading first lets us return a tidy 409.
    const existing = await this.headersRepo.findByInvoice(dto.supplierId, dto.invoiceNumber);
    if (existing) {
      throw new DomainConflictException(
        `Invoice ${dto.invoiceNumber} already recorded for this supplier`,
        ErrorCode.DUPLICATE_RESOURCE,
        {
          metadata: {
            supplierId: dto.supplierId,
            invoiceNumber: dto.invoiceNumber,
            existingGrnId: existing.id,
          },
        },
      );
    }

    return this.db.transaction(async (tx) => {
      const grnNumber = await this.numberGenerator.generateForStore(
        tenantId,
        dto.storeId,
        dto.inwardDate,
      );

      const created = await this.headersRepo.create(
        {
          tenantId,
          storeId: dto.storeId,
          grnNumber,
          supplierId: dto.supplierId,
          invoiceNumber: dto.invoiceNumber,
          invoiceDate: dto.invoiceDate,
          poNumber: dto.poNumber,
          inwardDate: dto.inwardDate,
          expectedDeliveryDate: dto.expectedDeliveryDate,
          orderDate: dto.orderDate,
          status: 'draft',
          subtotal: dto.subtotal !== undefined ? dto.subtotal.toString() : null,
          taxAmount: dto.taxAmount !== undefined ? dto.taxAmount.toString() : null,
          totalAmount: dto.totalAmount !== undefined ? dto.totalAmount.toString() : null,
          notes: dto.notes,
          metadata: dto.metadata ?? {},
          createdBy: userId,
        },
        tx,
      );

      let withItems = created;
      if (dto.items && dto.items.length > 0) {
        const { totals } = await this.appendItemsInternal(created, dto.items, userId, tx);
        withItems = await this.headersRepo.update(
          created.id,
          {
            totalItems: totals.itemCount,
            totalQuantity: totals.quantity,
          },
          tx,
        );
      }

      await this.eventsRepo.create(
        {
          grnId: created.id,
          tenantId,
          type: 'created',
          actorId: userId,
          metadata: { itemCount: dto.items?.length ?? 0 },
        },
        tx,
      );

      await this.auditLog.logAction({
        action: 'CREATE',
        resourceType: 'Grn',
        resourceId: created.id,
        userId,
        tenantId,
        success: true,
        metadata: {
          grnNumber,
          supplierId: dto.supplierId,
          itemCount: dto.items?.length ?? 0,
        },
      });

      this.logger.info('grn.created', {
        grnId: created.id,
        tenantId,
        grnNumber,
      });

      return withItems;
    });
  }

  async updateDraft(tenantId: string, userId: string, id: string, dto: UpdateGrnDto): Promise<Grn> {
    const grn = await this.headersRepo.findByIdInTenant(id, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', id);
    this.assertEditable(grn.status);

    return this.db.transaction(async (tx) => {
      const patch: Partial<Grn> = {};
      if (dto.invoiceNumber !== undefined) patch.invoiceNumber = dto.invoiceNumber;
      if (dto.invoiceDate !== undefined) patch.invoiceDate = dto.invoiceDate;
      if (dto.poNumber !== undefined) patch.poNumber = dto.poNumber;
      if (dto.inwardDate !== undefined) patch.inwardDate = dto.inwardDate;
      if (dto.expectedDeliveryDate !== undefined)
        patch.expectedDeliveryDate = dto.expectedDeliveryDate;
      if (dto.orderDate !== undefined) patch.orderDate = dto.orderDate;
      if (dto.subtotal !== undefined) patch.subtotal = dto.subtotal.toString();
      if (dto.taxAmount !== undefined) patch.taxAmount = dto.taxAmount.toString();
      if (dto.totalAmount !== undefined) patch.totalAmount = dto.totalAmount.toString();
      if (dto.notes !== undefined) patch.notes = dto.notes;
      if (dto.metadata !== undefined) patch.metadata = dto.metadata;

      const updated = await this.headersRepo.update(id, { ...patch, updatedBy: userId }, tx);

      await this.eventsRepo.create(
        {
          grnId: id,
          tenantId,
          type: 'updated',
          actorId: userId,
          metadata: { fields: Object.keys(patch) },
        },
        tx,
      );

      await this.auditLog.logAction({
        action: 'UPDATE',
        resourceType: 'Grn',
        resourceId: id,
        userId,
        tenantId,
        success: true,
        metadata: { transition: 'edit' },
      });

      return updated;
    });
  }

  /* ─────────────────── Item management ─────────────────── */

  async addItems(
    tenantId: string,
    userId: string,
    grnId: string,
    items: GrnItemDto[],
  ): Promise<GrnItem[]> {
    const grn = await this.headersRepo.findByIdInTenant(grnId, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', grnId);
    this.assertEditable(grn.status);

    return this.db.transaction(async (tx) => {
      const { created, totals } = await this.appendItemsInternal(grn, items, userId, tx);
      await this.headersRepo.update(
        grn.id,
        {
          totalItems: totals.itemCount,
          totalQuantity: totals.quantity,
        },
        tx,
      );
      await this.eventsRepo.create(
        {
          grnId,
          tenantId,
          type: 'item_added',
          actorId: userId,
          metadata: { added: items.length },
        },
        tx,
      );
      return created;
    });
  }

  async updateItem(
    tenantId: string,
    userId: string,
    grnId: string,
    itemId: string,
    dto: UpdateGrnItemDto,
  ): Promise<GrnItem> {
    const grn = await this.headersRepo.findByIdInTenant(grnId, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', grnId);
    this.assertEditable(grn.status);

    const existing = await this.itemsRepo.findByIdInGrn(itemId, grnId);
    if (!existing) throw new DomainNotFoundException('GrnItem', itemId);

    return this.db.transaction(async (tx) => {
      const patch: Partial<GrnItem> = {};
      if (dto.productId !== undefined) patch.productId = dto.productId;
      if (dto.productName !== undefined) patch.productNameSnapshot = dto.productName;
      if (dto.quantity !== undefined) patch.quantity = dto.quantity;
      if (dto.unit !== undefined) patch.unit = dto.unit;
      if (dto.batchNumber !== undefined) patch.batchNumber = dto.batchNumber;
      if (dto.manufactureDate !== undefined) patch.manufactureDate = dto.manufactureDate;
      if (dto.expiryDate !== undefined) {
        patch.expiryDate = dto.expiryDate;
        patch.expiryRemainingDays = this.daysUntilExpiry(dto.expiryDate);
      }
      if (dto.unitPrice !== undefined) {
        patch.unitPrice = dto.unitPrice.toString();
        const qty = dto.quantity ?? existing.quantity;
        patch.totalPrice = (dto.unitPrice * qty).toString();
      }
      if (dto.taxPercent !== undefined) patch.taxPercent = dto.taxPercent.toString();
      if (dto.notes !== undefined) patch.notes = dto.notes;

      const updated = await this.itemsRepo.update(itemId, patch, tx);

      // Refresh header counters when quantity changed.
      if (dto.quantity !== undefined && dto.quantity !== existing.quantity) {
        const allItems = await this.itemsRepo.findByGrn(grnId, tx);
        const totalQuantity = allItems.reduce((sum, i) => sum + i.quantity, 0);
        await this.headersRepo.update(grnId, { totalQuantity, updatedBy: userId }, tx);
      }

      await this.eventsRepo.create(
        {
          grnId,
          tenantId,
          type: 'item_updated',
          actorId: userId,
          metadata: { itemId, fields: Object.keys(patch) },
        },
        tx,
      );

      return updated;
    });
  }

  async removeItem(tenantId: string, userId: string, grnId: string, itemId: string): Promise<void> {
    const grn = await this.headersRepo.findByIdInTenant(grnId, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', grnId);
    this.assertEditable(grn.status);

    await this.db.transaction(async (tx) => {
      const removed = await this.itemsRepo.deleteForGrn(itemId, grnId, tx);
      if (!removed) throw new DomainNotFoundException('GrnItem', itemId);

      const remaining = await this.itemsRepo.findByGrn(grnId, tx);
      const totalQuantity = remaining.reduce((s, i) => s + i.quantity, 0);
      await this.headersRepo.update(
        grnId,
        {
          totalItems: remaining.length,
          totalQuantity,
          updatedBy: userId,
        },
        tx,
      );

      await this.eventsRepo.create(
        {
          grnId,
          tenantId,
          type: 'item_removed',
          actorId: userId,
          metadata: { itemId },
        },
        tx,
      );
    });
  }

  /* ─────────────────── Workflow ─────────────────── */

  async validate(tenantId: string, grnId: string): Promise<ValidationResult> {
    return this.validationService.validate(grnId, tenantId);
  }

  async post(tenantId: string, userId: string, grnId: string): Promise<PostResult> {
    return this.postingService.post(grnId, tenantId, userId);
  }

  async cancel(tenantId: string, userId: string, grnId: string, reason: string): Promise<Grn> {
    const grn = await this.headersRepo.findByIdInTenant(grnId, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', grnId);
    if (grn.status === 'posted') {
      throw new BusinessException(
        ErrorCode.GRN_ALREADY_POSTED,
        'Cannot cancel a posted GRN — use reverse instead',
      );
    }
    if (grn.status === 'cancelled') {
      throw new BusinessException(ErrorCode.BUSINESS_RULE_VIOLATION, 'GRN is already cancelled');
    }
    if (grn.status === 'reversed') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot cancel a reversed GRN',
      );
    }

    return this.db.transaction(async (tx) => {
      const updated = await this.headersRepo.updateStatusGuarded(
        grnId,
        ['draft', 'pending_review'],
        {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: userId,
          cancellationReason: reason,
        },
        tx,
      );
      if (!updated) {
        throw new BusinessException(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'GRN status changed concurrently — please refresh and retry',
        );
      }

      await this.eventsRepo.create(
        {
          grnId,
          tenantId,
          type: 'cancelled',
          actorId: userId,
          notes: reason,
        },
        tx,
      );

      await this.auditLog.logAction({
        action: 'UPDATE',
        resourceType: 'Grn',
        resourceId: grnId,
        userId,
        tenantId,
        success: true,
        metadata: { transition: 'cancel', reason },
      });

      return updated;
    });
  }

  async reverse(
    tenantId: string,
    userId: string,
    grnId: string,
    reason: string,
  ): Promise<ReverseResult> {
    return this.reversalService.reverse(grnId, tenantId, userId, reason);
  }

  /* ─────────────────── Reads ─────────────────── */

  async findById(tenantId: string, id: string): Promise<GrnWithDetails> {
    const grn = await this.headersRepo.findByIdInTenant(id, tenantId);
    if (!grn) throw new DomainNotFoundException('Grn', id);
    const [items, events] = await Promise.all([
      this.itemsRepo.findByGrn(id),
      this.eventsRepo.findByGrn(id, tenantId),
    ]);
    return { ...grn, items, events };
  }

  async list(tenantId: string, query: ListGrnsQueryDto): Promise<PaginatedResult<Grn>> {
    return this.headersRepo.findPaginatedScoped(tenantId, {
      storeId: query.storeId,
      supplierId: query.supplierId,
      status: query.status,
      invoiceNumber: query.invoiceNumber,
      fromDate: query.fromDate,
      toDate: query.toDate,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  async listForSupplier(
    tenantId: string,
    supplierId: string,
    query: ListGrnsQueryDto,
  ): Promise<PaginatedResult<Grn>> {
    return this.headersRepo.findPaginatedScoped(tenantId, {
      ...query,
      supplierId,
    });
  }

  async getStats(tenantId: string, query: GrnStatsQueryDto): Promise<GrnStats> {
    return this.headersRepo.getStats(tenantId, query.storeId ?? null, query.fromDate, query.toDate);
  }

  /* ─────────────────── Helpers ─────────────────── */

  /** Throws when a GRN can't be edited because it's left draft state. */
  private assertEditable(status: Grn['status']): void {
    if (status === 'posted') {
      throw new BusinessException(
        ErrorCode.GRN_ALREADY_POSTED,
        'Cannot modify a posted GRN — use reverse instead',
      );
    }
    if (status === 'cancelled' || status === 'reversed') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot modify a GRN in '${status}' state`,
      );
    }
  }

  private daysUntilExpiry(date: Date): number {
    return Math.floor((date.getTime() - Date.now()) / 86_400_000);
  }

  /**
   * Inserts items, returns them along with refreshed header totals.
   * Caller is responsible for persisting the totals; we keep this
   * helper pure so create-with-items and add-items share the body.
   *
   * `userId` is intentionally unused for line items — identity comes
   * from the parent GRN's audit row, so we don't double-stamp the
   * actor on every line.
   */
  private async appendItemsInternal(
    grn: Grn,
    items: GrnItemDto[],
    _userId: string,
    tx: Transaction,
  ): Promise<{
    created: GrnItem[];
    totals: { itemCount: number; quantity: number };
  }> {
    const created: GrnItem[] = [];
    let addedQuantity = 0;
    for (const item of items) {
      const expiryRemainingDays = item.expiryDate ? this.daysUntilExpiry(item.expiryDate) : null;
      const totalPrice =
        item.unitPrice !== undefined ? (item.unitPrice * item.quantity).toString() : null;

      const inserted = await this.itemsRepo.create(
        {
          grnId: grn.id,
          tenantId: grn.tenantId,
          storeId: grn.storeId,
          productId: item.productId,
          ean: item.ean,
          productNameSnapshot: item.productName,
          quantity: item.quantity,
          unit: item.unit ?? 'pcs',
          batchNumber: item.batchNumber,
          manufactureDate: item.manufactureDate,
          expiryDate: item.expiryDate,
          expiryRemainingDays,
          unitPrice: item.unitPrice !== undefined ? item.unitPrice.toString() : null,
          taxPercent: item.taxPercent !== undefined ? item.taxPercent.toString() : null,
          totalPrice,
          notes: item.notes,
        },
        tx,
      );
      created.push(inserted);
      addedQuantity += item.quantity;
    }

    return {
      created,
      totals: {
        itemCount: grn.totalItems + items.length,
        quantity: grn.totalQuantity + addedQuantity,
      },
    };
  }
}
