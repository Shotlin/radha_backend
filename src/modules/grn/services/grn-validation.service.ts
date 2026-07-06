import { Injectable } from '@nestjs/common';

import { ProductsRepository } from '@/modules/products/products.repository';

import { GrnHeadersRepository } from '../repositories/grn-headers.repository';
import { GrnItemsRepository } from '../repositories/grn-items.repository';
import type { ValidationError, ValidationResult, ValidationWarning } from '../types/grn.types';

/**
 * BE-26 — Pre-post validation.
 *
 * Splits feedback into two channels:
 *   - **errors**   block posting (e.g. missing supplier, no items,
 *                  zero / negative quantity, expiry < manufacture).
 *   - **warnings** surface but don't block (e.g. short shelf life,
 *                  past expiry, duplicate batch within the GRN,
 *                  unknown product). The user can still post — the
 *                  warnings are informational and end up in the
 *                  `posted` event metadata for traceability.
 *
 * The hard data-integrity guarantees (duplicate invoices, duplicate
 * batches per GRN) are enforced at the storage layer via unique
 * indexes; this validator gives a friendlier 422 error before the
 * insert is attempted.
 */
@Injectable()
export class GrnValidationService {
  /** Items expiring within this many days are flagged as "short shelf life". */
  static readonly SHORT_SHELF_LIFE_DAYS = 30;

  constructor(
    private readonly headersRepo: GrnHeadersRepository,
    private readonly itemsRepo: GrnItemsRepository,
    private readonly productsRepo: ProductsRepository,
  ) {}

  async validate(grnId: string, tenantId: string): Promise<ValidationResult> {
    const grn = await this.headersRepo.findByIdInTenant(grnId, tenantId);
    if (!grn) {
      return {
        valid: false,
        errors: [{ field: 'id', message: 'GRN not found' }],
        warnings: [],
      };
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Header-level checks. Most of these are enforced by the DTO too,
    // but we re-check here so a posted GRN can never bypass them via
    // direct DB writes (e.g. an admin script).
    if (!grn.invoiceNumber) {
      errors.push({ field: 'invoiceNumber', message: 'Invoice number required' });
    }
    if (!grn.supplierId) {
      errors.push({ field: 'supplierId', message: 'Supplier required' });
    }
    if (!grn.inwardDate) {
      errors.push({ field: 'inwardDate', message: 'Inward date required' });
    }

    const items = await this.itemsRepo.findByGrn(grnId);
    if (items.length === 0) {
      errors.push({ field: 'items', message: 'At least one item required' });
    }

    const seenBatches = new Set<string>();
    const now = Date.now();

    for (const item of items) {
      if (!item.ean) {
        errors.push({ field: 'ean', itemId: item.id, message: 'EAN required' });
      }
      if (item.quantity === null || item.quantity === undefined || item.quantity <= 0) {
        errors.push({
          field: 'quantity',
          itemId: item.id,
          message: 'Quantity must be > 0',
        });
      }

      if (
        item.expiryDate &&
        item.manufactureDate &&
        item.expiryDate.getTime() <= item.manufactureDate.getTime()
      ) {
        errors.push({
          field: 'expiryDate',
          itemId: item.id,
          message: 'Expiry must be after manufacture date',
        });
      }

      if (item.expiryDate) {
        const daysRemaining = Math.floor((item.expiryDate.getTime() - now) / 86_400_000);

        if (daysRemaining < 0) {
          warnings.push({
            type: 'past_expiry',
            message: `Item ${item.ean} is already expired`,
            itemId: item.id,
          });
        } else if (daysRemaining < GrnValidationService.SHORT_SHELF_LIFE_DAYS) {
          warnings.push({
            type: 'short_shelf_life',
            message: `Item ${item.ean} has only ${daysRemaining} days until expiry`,
            itemId: item.id,
          });
        }
      }

      if (item.batchNumber) {
        const key = `${item.ean}:${item.batchNumber}`;
        if (seenBatches.has(key)) {
          warnings.push({
            type: 'duplicate_batch',
            message: `Duplicate batch ${item.batchNumber} for EAN ${item.ean}`,
            itemId: item.id,
          });
        }
        seenBatches.add(key);
      }

      if (!item.productId) {
        const existing = await this.productsRepo.findVisibleByEan(item.ean, tenantId);
        if (!existing) {
          warnings.push({
            type: 'unknown_product',
            message: `Product ${item.ean} not in catalog. Will be auto-created at posting.`,
            itemId: item.id,
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
