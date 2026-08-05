import { ConflictException, Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import type { ExpiryRecordRow } from '@/db/schema/expiry';
import { LoggerService } from '@/logging/logger.service';
import { ProductsRepository } from '@/modules/products/products.repository';
import { IdempotencyService } from '@/modules/sync/services/idempotency.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  CreateExpiryRecordDto,
  ListExpiryRecordsQueryDto,
  UpdateExpiryQuantityDto,
} from './dto/expiry.dto';
import { ExpiryAlertsRepository } from './repositories/expiry-alerts.repository';
import { ExpiryRecordsRepository } from './repositories/expiry-records.repository';
import { ExpiryAlertService } from './services/expiry-alert.service';
import { ExpiryCalculatorService } from './services/expiry-calculator.service';
import { ExpiryThresholdService } from './services/expiry-threshold.service';
import type {
  CategoryExpiryStats,
  ExpiryFilters,
  ExpiryForecast,
  ExpiryStats,
  ExpiryStatus,
  RecalculationResult,
} from './types/expiry.types';

/** `ExpiryRecordRow` plus the product's display name and EAN, joined in
 * the service layer (spec §B2.2) so the app's expiry list/calendar can
 * render a real product name + barcode instead of an 8-char product-id
 * token. `ean` addition: the calendar day-detail view needs the barcode
 * alongside the name so store staff can tell apart same-named SKUs. */
export type ExpiryRecordWithProductName = ExpiryRecordRow & {
  productName: string | null;
  ean: string | null;
};

const IDEMPOTENCY_PATH_LABEL = 'expiry-records';
const UPDATE_QUANTITY_IDEMPOTENCY_PATH_LABEL = 'expiry-records/:id/quantity';

@Injectable()
export class ExpiryService {
  constructor(
    private readonly db: DbService,
    private readonly recordsRepo: ExpiryRecordsRepository,
    private readonly alertsRepo: ExpiryAlertsRepository,
    private readonly calculator: ExpiryCalculatorService,
    private readonly thresholds: ExpiryThresholdService,
    private readonly alertService: ExpiryAlertService,
    private readonly products: ProductsRepository,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /* ─────────────────── Records ─────────────────── */

  /**
   * §B2.2: a replayed create carrying the same `Idempotency-Key` returns
   * the original record instead of inserting a duplicate. Applied
   * explicitly here rather than relying on `SyncModule`'s app-wide
   * `IdempotencyMiddleware` — that middleware runs BEFORE guards in the
   * Nest request lifecycle, so on a `@UseGuards(JwtAuthGuard)` route
   * `req.user` isn't populated yet when it executes and it silently
   * skips idempotency for lack of a user to scope the record to
   * (verified live: two identical requests with the same key produced
   * two different record ids before this fix).
   */
  async createRecord(
    tenantId: string,
    userId: string,
    dto: CreateExpiryRecordDto,
    idempotencyKey?: string,
  ): Promise<ExpiryRecordWithProductName> {
    const requestHash = idempotencyKey
      ? this.idempotency.hashRequest({
          method: 'POST',
          path: IDEMPOTENCY_PATH_LABEL,
          body: dto,
        })
      : null;

    if (idempotencyKey && requestHash) {
      const cached = await this.idempotency.lookup(idempotencyKey);
      if (cached) {
        if (cached.requestHash !== requestHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSE',
            message: 'Idempotency-Key reused with a different request payload',
          });
        }
        return cached.responseBody as ExpiryRecordWithProductName;
      }
    }

    const product = await this.products.findById(dto.productId);
    if (!product) throw new DomainNotFoundException('Product', dto.productId);

    const threshold = await this.thresholds.resolve(product.subCategory, tenantId);
    const status = this.calculator.calculateStatus(dto.expiryDate, threshold);
    const daysRemaining = this.calculator.daysUntilExpiry(dto.expiryDate);

    const result = await this.db.transaction(async (tx) => {
      const created = await this.recordsRepo.create(
        {
          tenantId,
          storeId: dto.storeId,
          productId: dto.productId,
          expiryDate: dto.expiryDate,
          manufactureDate: dto.manufactureDate,
          batchNumber: dto.batchNumber,
          quantity: dto.quantity,
          remainingQuantity: dto.quantity,
          status,
          daysRemaining,
          source: dto.source,
          sourceId: dto.sourceId,
          shelfLocation: dto.shelfLocation,
          notes: dto.notes,
          createdBy: userId,
        },
        tx,
      );

      if (status === 'yellow' || status === 'red' || status === 'expired') {
        const alertStatus = status === 'expired' ? 'red' : status;
        await this.alertService.ensureForRecord(created, alertStatus, tx);
      }

      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'ExpiryRecord',
        resourceId: created.id,
        userId,
        tenantId,
        success: true,
        metadata: { productId: dto.productId, status, source: dto.source },
      });

      return { ...created, productName: product.name, ean: product.ean };
    });

    if (idempotencyKey && requestHash) {
      await this.idempotency.persist({
        key: idempotencyKey,
        userId,
        requestHash,
        response: { status: 201, body: result },
      });
    }

    return result;
  }

  async findById(tenantId: string, id: string): Promise<ExpiryRecordWithProductName> {
    const row = await this.recordsRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('ExpiryRecord', id);
    const [withNames] = await this._withProductNames([row]);
    return withNames;
  }

  /**
   * Quick Audit scan mode (Feature C) — a store-walk stock check-in: scan a
   * barcode, see the existing record, bump `remainingQuantity` up/down,
   * save. Mirrors `createRecord`'s explicit-in-service idempotency pattern
   * for the same documented reason (the app-wide `IdempotencyMiddleware`
   * runs before guards, so `req.user` isn't populated yet on a
   * `@UseGuards(JwtAuthGuard)` route).
   */
  async updateQuantity(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateExpiryQuantityDto,
    idempotencyKey?: string,
  ): Promise<ExpiryRecordWithProductName> {
    const requestHash = idempotencyKey
      ? this.idempotency.hashRequest({
          method: 'PATCH',
          path: UPDATE_QUANTITY_IDEMPOTENCY_PATH_LABEL,
          body: dto,
        })
      : null;

    if (idempotencyKey && requestHash) {
      const cached = await this.idempotency.lookup(idempotencyKey);
      if (cached) {
        if (cached.requestHash !== requestHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSE',
            message: 'Idempotency-Key reused with a different request payload',
          });
        }
        return cached.responseBody as ExpiryRecordWithProductName;
      }
    }

    const existing = await this.recordsRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('ExpiryRecord', id);

    const updated = await this.recordsRepo.updateQuantity(id, dto.remainingQuantity);

    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ExpiryRecord',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: {
        field: 'remainingQuantity',
        from: existing.remainingQuantity,
        to: dto.remainingQuantity,
      },
    });

    const [withName] = await this._withProductNames([updated]);

    if (idempotencyKey && requestHash) {
      await this.idempotency.persist({
        key: idempotencyKey,
        userId,
        requestHash,
        response: { status: 200, body: withName },
      });
    }

    return withName;
  }

  async list(
    tenantId: string,
    query: ListExpiryRecordsQueryDto,
  ): Promise<ExpiryRecordWithProductName[]> {
    const filters: ExpiryFilters = {
      status: query.status as ExpiryStatus[] | undefined,
      productId: query.productId,
      limit: query.limit,
    };
    if (query.daysAhead !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + query.daysAhead);
      filters.toDate = cutoff;
    }
    const rows = await this.recordsRepo.listForStore(tenantId, query.storeId, {
      ...filters,
      limit: query.limit,
    });
    return this._withProductNames(rows);
  }

  /** Batch-attaches `productName` + `ean` to each row via one lookup per
   * unique `productId` (bounded by the query's own `limit`, so this never
   * scans more products than records returned). No repository/schema join
   * is needed since `ProductsRepository.findById` already exists. */
  private async _withProductNames(
    rows: ExpiryRecordRow[],
  ): Promise<ExpiryRecordWithProductName[]> {
    const uniqueIds = [...new Set(rows.map((r) => r.productId))];
    const entries = await Promise.all(
      uniqueIds.map(async (id) => {
        const product = await this.products.findById(id);
        return [id, { name: product?.name ?? null, ean: product?.ean ?? null }] as const;
      }),
    );
    const infoById = new Map(entries);
    return rows.map((r) => {
      const info = infoById.get(r.productId);
      return { ...r, productName: info?.name ?? null, ean: info?.ean ?? null };
    });
  }

  async findNearExpiry(
    tenantId: string,
    storeId: string,
    daysAhead: number,
  ): Promise<ExpiryRecordRow[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + daysAhead);
    return this.recordsRepo.findNearExpiry(tenantId, storeId, cutoff);
  }

  async findExpired(tenantId: string, storeId: string): Promise<ExpiryRecordRow[]> {
    return this.recordsRepo.findExpired(tenantId, storeId);
  }

  /* ─────────────────── Aggregations ─────────────────── */

  async getStoreStats(tenantId: string, storeId: string): Promise<ExpiryStats> {
    return this.recordsRepo.getStoreStats(tenantId, storeId);
  }

  async getCategoryStats(tenantId: string, storeId: string): Promise<CategoryExpiryStats[]> {
    return this.recordsRepo.getCategoryStats(tenantId, storeId);
  }

  async forecast(tenantId: string, storeId: string, daysAhead: number): Promise<ExpiryForecast> {
    return this.recordsRepo.getForecast(tenantId, storeId, daysAhead);
  }

  /* ─────────────────── Recalculation ─────────────────── */

  async recalculateForStore(
    tenantId: string,
    userId: string,
    storeId: string,
  ): Promise<RecalculationResult> {
    const records = await this.recordsRepo.streamForStore(tenantId, storeId);
    if (records.length === 0) {
      return { scanned: 0, updated: 0, alertsCreated: 0 };
    }

    // Cache thresholds per (category) so we hit the DB once per category.
    const thresholdCache = new Map<string, Awaited<ReturnType<typeof this.thresholds.resolve>>>();
    const productCache = new Map<string, string | null>();
    let updated = 0;
    let alertsCreated = 0;
    const now = new Date();

    for (const record of records) {
      let category = productCache.get(record.productId);
      if (category === undefined) {
        const product = await this.products.findById(record.productId);
        category = product?.subCategory ?? 'other';
        productCache.set(record.productId, category);
      }
      const cacheKey = (category ?? 'other').toLowerCase();
      let threshold = thresholdCache.get(cacheKey);
      if (!threshold) {
        threshold = await this.thresholds.resolve(category, tenantId);
        thresholdCache.set(cacheKey, threshold);
      }

      const newStatus = this.calculator.calculateStatus(record.expiryDate, threshold, now);
      const newDays = this.calculator.daysUntilExpiry(record.expiryDate, now);

      if (newStatus === record.status && newDays === record.daysRemaining) continue;

      await this.recordsRepo.updateStatus(record.id, newStatus, newDays);
      updated++;

      if (newStatus === 'yellow' || newStatus === 'red' || newStatus === 'expired') {
        const alertStatus = newStatus === 'expired' ? 'red' : newStatus;
        const refreshed: ExpiryRecordRow = {
          ...record,
          status: newStatus,
          daysRemaining: newDays,
        };
        const before = await this.alertsRepo.findActiveByRecord(record.id, alertStatus);
        await this.alertService.ensureForRecord(refreshed, alertStatus);
        if (!before) alertsCreated++;
      }
    }

    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ExpiryRecord',
      resourceId: storeId,
      userId,
      tenantId,
      success: true,
      metadata: {
        transition: 'recalculate',
        scanned: records.length,
        updated,
        alertsCreated,
      },
    });

    this.logger.info('expiry.recalculated', {
      storeId,
      tenantId,
      scanned: records.length,
      updated,
      alertsCreated,
    });

    return { scanned: records.length, updated, alertsCreated };
  }
}
