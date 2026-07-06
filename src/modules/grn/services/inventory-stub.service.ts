import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import type {
  IInventoryService,
  InventoryMovementRequest,
  InventoryMovementResult,
} from '../types/grn.types';

/**
 * BE-26 — In-process fallback for the BE-27 `IInventoryService`.
 *
 * BE-27 (the inventory module) is the eventual owner of inbound /
 * outbound stock movements. Until it ships, the GRN posting flow
 * still needs SOMETHING under `INVENTORY_SERVICE_TOKEN` so the DI
 * graph resolves and the rest of the posting transaction works
 * end-to-end.
 *
 * This stub:
 *   - logs every call at info level (so we can audit the deferred
 *     inventory effects post-hoc),
 *   - returns synthetic ids so the `grn_items` rows can be linked
 *     and the audit metadata is consistent,
 *   - reports `newQuantity = quantity` (no aggregation).
 *
 * The handoff doc flags this as a deferred contract; once BE-27
 * lands, swap it via `GrnModule` provider override and the GRN
 * module is unaffected.
 */
@Injectable()
export class InventoryStubService implements IInventoryService {
  constructor(private readonly logger: LoggerService) {}

  async applyInbound(req: InventoryMovementRequest): Promise<InventoryMovementResult> {
    this.logger.info('grn.inventory.deferred.inbound', {
      reason: 'BE-27 inventory module not yet wired — recording intent only',
      tenantId: req.tenantId,
      storeId: req.storeId,
      productId: req.productId,
      quantity: req.quantity,
      sourceLineId: req.sourceLineId,
    });
    return {
      inventoryItemId: this.synthId('itm', req.sourceLineId),
      stockMovementId: this.synthId('mov', req.sourceLineId),
      newQuantity: req.quantity,
    };
  }

  async applyOutbound(req: InventoryMovementRequest): Promise<InventoryMovementResult> {
    this.logger.info('grn.inventory.deferred.outbound', {
      reason: 'BE-27 inventory module not yet wired — recording intent only',
      tenantId: req.tenantId,
      storeId: req.storeId,
      productId: req.productId,
      quantity: req.quantity,
      sourceLineId: req.sourceLineId,
    });
    return {
      inventoryItemId: this.synthId('itm', req.sourceLineId),
      stockMovementId: this.synthId('mov', `rev-${req.sourceLineId}`),
      newQuantity: 0,
    };
  }

  /**
   * Deterministic synthetic id derived from the line item id + a
   * 3-letter tag so two stub calls on the same line return the same
   * synthetic ids. Not a UUID — clearly marked so anyone querying
   * downstream can spot deferred records.
   */
  private synthId(tag: string, sourceLineId: string): string {
    return `stub-${tag}-${sourceLineId}`;
  }
}
