import { Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import type { ExpiryRecordRow } from '@/db/schema/expiry';
import { LoggerService } from '@/logging/logger.service';
import { ProductsRepository } from '@/modules/products/products.repository';
import { AuditLogService } from '@/observability/audit-log.service';

import { CreateExpiryRecordDto, ListExpiryRecordsQueryDto } from './dto/expiry.dto';
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
  ) {}

  /* ─────────────────── Records ─────────────────── */

  async createRecord(
    tenantId: string,
    userId: string,
    dto: CreateExpiryRecordDto,
  ): Promise<ExpiryRecordRow> {
    const product = await this.products.findById(dto.productId);
    if (!product) throw new DomainNotFoundException('Product', dto.productId);

    const threshold = await this.thresholds.resolve(product.subCategory, tenantId);
    const status = this.calculator.calculateStatus(dto.expiryDate, threshold);
    const daysRemaining = this.calculator.daysUntilExpiry(dto.expiryDate);

    return this.db.transaction(async (tx) => {
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

      return created;
    });
  }

  async findById(tenantId: string, id: string): Promise<ExpiryRecordRow> {
    const row = await this.recordsRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('ExpiryRecord', id);
    return row;
  }

  async list(tenantId: string, query: ListExpiryRecordsQueryDto): Promise<ExpiryRecordRow[]> {
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
    return this.recordsRepo.listForStore(tenantId, query.storeId, {
      ...filters,
      limit: query.limit,
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
