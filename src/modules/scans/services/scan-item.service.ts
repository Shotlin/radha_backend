import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import type { ProductRow } from '@/db/schema/products';
import type { ScanItemRow } from '@/db/schema/scans';
import { LoggerService } from '@/logging/logger.service';
import { EanMatcherService } from '@/modules/ean-lists/services/ean-matcher.service';
import { ProductLookupService } from '@/modules/products/services/product-lookup.service';
import { normaliseEan, validateEan } from '@/modules/products/utils/ean.utils';

import { ScanItemDto } from '../dto/scans.dto';
import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { ScanSessionsRepository } from '../repositories/scan-sessions.repository';
import type { EanMatchStatus, ScanItemResult, ScanWarning } from '../types/scan.types';
import { calculateExpiryStatus } from '../utils/scan-stats.utils';

import { DuplicateDetectorService } from './duplicate-detector.service';

@Injectable()
export class ScanItemService {
  constructor(
    private readonly db: DbService,
    private readonly itemsRepo: ScanItemsRepository,
    private readonly sessionsRepo: ScanSessionsRepository,
    private readonly productLookup: ProductLookupService,
    private readonly eanMatcher: EanMatcherService,
    private readonly duplicates: DuplicateDetectorService,
    private readonly logger: LoggerService,
  ) {}

  async recordScan(
    tenantId: string,
    userId: string,
    sessionId: string,
    dto: ScanItemDto,
  ): Promise<ScanItemResult> {
    const session = await this.sessionsRepo.findByIdInTenant(sessionId, tenantId);
    if (!session) throw new DomainNotFoundException('ScanSession', sessionId);
    if (session.userId !== userId) {
      throw new DomainForbiddenException('Not your session');
    }
    if (session.status !== 'active') {
      throw new BusinessException(
        ErrorCode.SCAN_SESSION_CLOSED,
        'Cannot scan into a closed session',
      );
    }

    // Validate format up-front so we don't waste a product lookup
    // on garbage input. Soft-fail (record `eanMatchStatus = 'invalid'`).
    const formatCheck = validateEan(dto.ean);
    if (!formatCheck.valid || !formatCheck.normalised) {
      return this.persistInvalidScan(session, userId, dto, formatCheck.error ?? 'Invalid EAN');
    }
    const ean = formatCheck.normalised;

    const productResult = await this.productLookup.lookupByEan(ean, tenantId, {
      includeNutrition: false,
      fallbackToExternal: true,
    });
    const product = productResult.found ? (productResult.product ?? null) : null;

    const eanValidation = await this.eanMatcher.validate(ean, tenantId, session.storeId);
    const eanMatchStatus = this.toMatchStatus(eanValidation);

    const duplicate = await this.duplicates.findDuplicate(sessionId, ean, dto.batchNumber ?? null);

    const expiryStatus = calculateExpiryStatus(dto.expiryDate ?? null);

    const warnings: ScanWarning[] = [];
    if (duplicate) {
      warnings.push({
        type: 'duplicate_in_session',
        message: 'This EAN was already scanned in this session',
        severity: 'warning',
      });
    }
    if (eanMatchStatus === 'unmatched') {
      warnings.push({
        type: 'unmatched_ean',
        message: 'Product not in approved list',
        severity: 'error',
      });
    } else if (eanMatchStatus === 'no_list') {
      warnings.push({
        type: 'no_active_list',
        message: 'No approved list active for this store',
        severity: 'info',
      });
    }
    if (expiryStatus === 'red') {
      warnings.push({
        type: 'expired_product',
        message: 'Product is expired or expires within 7 days',
        severity: 'error',
      });
    } else if (expiryStatus === 'yellow') {
      warnings.push({
        type: 'near_expiry',
        message: 'Product expires within 30 days',
        severity: 'warning',
      });
    }
    if (!product) {
      warnings.push({
        type: 'product_unknown',
        message: 'Product not yet in catalog',
        severity: 'info',
      });
    }

    return this.db.transaction(async (tx) => {
      const scanItem = await this.itemsRepo.insert(
        {
          sessionId,
          tenantId,
          storeId: session.storeId,
          userId,
          ean,
          productId: product?.id ?? null,
          productNameSnapshot: product?.name ?? dto.notes ?? null,
          brandSnapshot: product?.brand ?? null,
          eanMatchStatus,
          expiryStatus,
          scannedAt: dto.scannedAt,
          expiryDate: dto.expiryDate ?? null,
          manufactureDate: dto.manufactureDate ?? null,
          batchNumber: dto.batchNumber ?? null,
          quantity: dto.quantity,
          shelfLocation: dto.shelfLocation ?? null,
          notes: dto.notes ?? null,
          imageMediaId: dto.imageMediaId ?? null,
          latitude: dto.latitude?.toString() ?? null,
          longitude: dto.longitude?.toString() ?? null,
          deviceId: dto.deviceId ?? null,
          clientId: dto.clientId ?? null,
        },
        tx,
      );

      const isFirstSeenEan = !duplicate;
      await this.sessionsRepo.applyCounterDeltas(
        sessionId,
        {
          totalScans: 1,
          uniqueProducts: isFirstSeenEan ? 1 : 0,
          matchedEans: eanMatchStatus === 'matched' ? 1 : 0,
          unmatchedEans: eanMatchStatus === 'unmatched' ? 1 : 0,
          expiredItems: expiryStatus === 'red' ? 1 : 0,
          nearExpiryItems: expiryStatus === 'yellow' ? 1 : 0,
          lastActivityAt: new Date(),
        },
        tx,
      );

      return {
        scanItem,
        product: product ?? undefined,
        eanValidation,
        expiryStatus,
        isDuplicate: !!duplicate,
        duplicateOf: duplicate ?? null,
        warnings,
      };
    });
  }

  async recordBatch(
    tenantId: string,
    userId: string,
    sessionId: string,
    items: ScanItemDto[],
  ): Promise<{ results: ScanItemResult[]; failures: Array<{ ean: string; error: string }> }> {
    const results: ScanItemResult[] = [];
    const failures: Array<{ ean: string; error: string }> = [];
    for (const item of items) {
      try {
        results.push(await this.recordScan(tenantId, userId, sessionId, item));
      } catch (err) {
        const msg = (err as Error).message ?? 'Unknown error';
        this.logger.warn('scan.batch.item_failed', {
          sessionId,
          ean: item.ean,
          error: { name: (err as Error).name, message: msg },
        });
        failures.push({ ean: item.ean, error: msg });
      }
    }
    return { results, failures };
  }

  async listForSession(tenantId: string, sessionId: string, limit: number): Promise<ScanItemRow[]> {
    const session = await this.sessionsRepo.findByIdInTenant(sessionId, tenantId);
    if (!session) throw new DomainNotFoundException('ScanSession', sessionId);
    return this.itemsRepo.listForSession(sessionId, limit);
  }

  async findById(tenantId: string, itemId: string): Promise<ScanItemRow> {
    const row = await this.itemsRepo.findByIdInTenant(itemId, tenantId);
    if (!row) throw new DomainNotFoundException('ScanItem', itemId);
    return row;
  }

  async removeFromSession(
    tenantId: string,
    userId: string,
    sessionId: string,
    itemId: string,
  ): Promise<void> {
    const session = await this.sessionsRepo.findByIdInTenant(sessionId, tenantId);
    if (!session) throw new DomainNotFoundException('ScanSession', sessionId);
    if (session.userId !== userId) {
      throw new DomainForbiddenException('Not your session');
    }
    if (session.status !== 'active') {
      throw new BusinessException(
        ErrorCode.SCAN_SESSION_CLOSED,
        'Cannot remove items from a closed session',
      );
    }

    const item = await this.itemsRepo.findByIdInTenant(itemId, tenantId);
    if (!item || item.sessionId !== sessionId) {
      throw new DomainNotFoundException('ScanItem', itemId);
    }

    await this.db.transaction(async (tx) => {
      await this.itemsRepo.softDelete(itemId, userId, tx);
      // Recompute counters from the items aggregate so we never drift.
      const aggregate = await this.itemsRepo.aggregateForSession(sessionId);
      await this.sessionsRepo.update(
        sessionId,
        {
          totalScans: aggregate.totalScans,
          uniqueProducts: aggregate.uniqueProducts,
          matchedEans: aggregate.matchedEans,
          unmatchedEans: aggregate.unmatchedEans,
          expiredItems: aggregate.expiredItems,
          nearExpiryItems: aggregate.nearExpiryItems,
          lastActivityAt: new Date(),
        },
        tx,
      );
    });
  }

  /* ─────────────────── helpers ─────────────────── */

  private toMatchStatus(
    validation: Awaited<ReturnType<EanMatcherService['validate']>>,
  ): EanMatchStatus {
    if (validation.matched) return 'matched';
    switch (validation.reason) {
      case 'invalid_format':
        return 'invalid';
      case 'no_active_list':
      case 'no_store':
        return 'no_list';
      case 'not_in_list':
      default:
        return 'unmatched';
    }
  }

  private async persistInvalidScan(
    session: { id: string; tenantId: string; storeId: string; metadata: unknown },
    userId: string,
    dto: ScanItemDto,
    reason: string,
  ): Promise<ScanItemResult> {
    const ean = normaliseEan(dto.ean);
    return this.db.transaction(async (tx) => {
      const scanItem = await this.itemsRepo.insert(
        {
          sessionId: session.id,
          tenantId: session.tenantId,
          storeId: session.storeId,
          userId,
          ean,
          productId: null,
          eanMatchStatus: 'invalid',
          expiryStatus: 'unknown',
          scannedAt: dto.scannedAt,
          expiryDate: dto.expiryDate ?? null,
          manufactureDate: dto.manufactureDate ?? null,
          batchNumber: dto.batchNumber ?? null,
          quantity: dto.quantity,
          shelfLocation: dto.shelfLocation ?? null,
          notes: dto.notes ?? null,
          imageMediaId: dto.imageMediaId ?? null,
          latitude: dto.latitude?.toString() ?? null,
          longitude: dto.longitude?.toString() ?? null,
          deviceId: dto.deviceId ?? null,
          clientId: null,
        },
        tx,
      );
      await this.sessionsRepo.applyCounterDeltas(
        session.id,
        { totalScans: 1, lastActivityAt: new Date() },
        tx,
      );
      return {
        scanItem,
        product: null as ProductRow | null,
        expiryStatus: 'unknown',
        isDuplicate: false,
        duplicateOf: null,
        warnings: [
          {
            type: 'invalid_ean',
            message: reason,
            severity: 'error',
          },
        ],
      };
    });
  }
}
