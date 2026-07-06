import { Injectable } from '@nestjs/common';

import { ProductsRepository } from '@/modules/products/products.repository';
import { validateEan } from '@/modules/products/utils/ean.utils';

import { EanListItemsRepository } from '../repositories/ean-list-items.repository';
import { EanListsRepository } from '../repositories/ean-lists.repository';
import type { EanValidationResult } from '../types/import.types';

/**
 * BE-15 — EAN matching engine.
 *
 * The hot path that BE-16 (scan validation) will call on every scan:
 *   `validate(ean, tenantId, storeId) → matched?`
 *
 * Resolution order:
 *   1. Format-validate the input.
 *   2. Resolve the active list for `(tenantId, storeId)` —
 *      store-specific list wins over tenant-wide list.
 *   3. Look up the EAN in that list.
 *   4. Optionally hydrate the linked product row.
 *
 * No ambient context — every method takes the tenant explicitly so
 * BE-16 can call this from inside a worker or scheduled job.
 */
@Injectable()
export class EanMatcherService {
  constructor(
    private readonly listsRepo: EanListsRepository,
    private readonly itemsRepo: EanListItemsRepository,
    private readonly productsRepo: ProductsRepository,
  ) {}

  async validate(
    rawEan: string,
    tenantId: string,
    storeId: string | null,
  ): Promise<EanValidationResult> {
    const formatCheck = validateEan(rawEan);
    if (!formatCheck.valid || !formatCheck.normalised) {
      return {
        valid: false,
        ean: rawEan,
        matched: false,
        reason: 'invalid_format',
        validatedAt: new Date(),
      };
    }
    const ean = formatCheck.normalised;

    if (!storeId) {
      return {
        valid: false,
        ean,
        matched: false,
        reason: 'no_store',
        validatedAt: new Date(),
      };
    }

    const activeList = await this.listsRepo.findActiveForStore(tenantId, storeId);
    if (!activeList) {
      return {
        valid: false,
        ean,
        matched: false,
        reason: 'no_active_list',
        validatedAt: new Date(),
      };
    }

    const item = await this.itemsRepo.findByListAndEan(activeList.id, ean);
    if (!item) {
      return {
        valid: false,
        ean,
        matched: false,
        reason: 'not_in_list',
        validatedAt: new Date(),
      };
    }

    const product = item.productId
      ? ((await this.productsRepo.findById(item.productId)) ?? undefined)
      : undefined;

    return {
      valid: true,
      ean,
      matched: true,
      listItem: item,
      product,
      validatedAt: new Date(),
    };
  }

  async validateBatch(
    rawEans: string[],
    tenantId: string,
    storeId: string | null,
  ): Promise<Map<string, EanValidationResult>> {
    const results = new Map<string, EanValidationResult>();
    if (rawEans.length === 0) return results;

    if (!storeId) {
      for (const ean of rawEans) {
        results.set(ean, {
          valid: false,
          ean,
          matched: false,
          reason: 'no_store',
          validatedAt: new Date(),
        });
      }
      return results;
    }

    const activeList = await this.listsRepo.findActiveForStore(tenantId, storeId);
    if (!activeList) {
      for (const ean of rawEans) {
        results.set(ean, {
          valid: false,
          ean,
          matched: false,
          reason: 'no_active_list',
          validatedAt: new Date(),
        });
      }
      return results;
    }

    // Collect format-valid EANs and remember the original input for the response key.
    const normalised = new Map<string, string[]>(); // normalisedEan -> originalEans[]
    const invalidByOriginal: string[] = [];
    for (const raw of rawEans) {
      const fc = validateEan(raw);
      if (!fc.valid || !fc.normalised) {
        invalidByOriginal.push(raw);
        continue;
      }
      const arr = normalised.get(fc.normalised) ?? [];
      arr.push(raw);
      normalised.set(fc.normalised, arr);
    }

    for (const raw of invalidByOriginal) {
      results.set(raw, {
        valid: false,
        ean: raw,
        matched: false,
        reason: 'invalid_format',
        validatedAt: new Date(),
      });
    }

    const items = await this.itemsRepo.findManyByListAndEans(activeList.id, [...normalised.keys()]);
    const byEan = new Map(items.map((i) => [i.ean, i]));

    for (const [normalisedEan, originals] of normalised.entries()) {
      const item = byEan.get(normalisedEan);
      for (const original of originals) {
        if (item) {
          results.set(original, {
            valid: true,
            ean: normalisedEan,
            matched: true,
            listItem: item,
            validatedAt: new Date(),
          });
        } else {
          results.set(original, {
            valid: false,
            ean: normalisedEan,
            matched: false,
            reason: 'not_in_list',
            validatedAt: new Date(),
          });
        }
      }
    }

    return results;
  }

  async getActiveListForStore(tenantId: string, storeId: string) {
    return this.listsRepo.findActiveForStore(tenantId, storeId);
  }
}
