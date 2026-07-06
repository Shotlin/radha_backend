import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { ScanSyncBatchRow } from '@/db/schema/scans';

import { BulkScanItemDto, BulkSyncDto, BulkSyncMetadataDto } from '../dto/sync.dto';
import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { ScanSessionsRepository } from '../repositories/scan-sessions.repository';
import { ScanSyncBatchesRepository } from '../repositories/scan-sync-batches.repository';
import type {
  BulkProcessResult,
  BulkSubmissionResult,
  BulkSyncError,
  BulkSyncStatus,
} from '../types/sync.types';

import { IdempotencyService } from './idempotency.service';
import { ScanItemService } from './scan-item.service';

/**
 * BE-17 — Bulk scan / offline-sync service.
 *
 * Two modes:
 *   - `processInline` — < `SYNC_THRESHOLD` items, returns synchronously.
 *   - `submitBatch`   — anything larger persists a `scan_sync_batches`
 *     row and (in v1) processes immediately within the API request.
 *     BE-24 swaps the inline call for a BullMQ job enqueue — the
 *     payload `(batchId, items)` is already shaped for that.
 *
 * Idempotency contract:
 *   - Every `BulkScanItemDto.clientId` is required.
 *   - Pre-batch, we look up all clientIds in one bulk query and
 *     skip the ones that already have a `scan_items` row.
 *   - Inside the loop, individual scan-item inserts are guarded by
 *     the unique partial index — a 23505 race produces a clean
 *     "duplicate" classification rather than a 500.
 */
@Injectable()
export class BulkScanService {
  /** Below this, callers get a synchronous response. */
  static readonly SYNC_THRESHOLD = 50;
  /** Above this, the request is rejected outright. */
  static readonly MAX_BATCH_SIZE = 5_000;
  /** Estimated per-item processing time in ms — used for ETA. */
  private static readonly PER_ITEM_ESTIMATE_MS = 30;
  /** Cap on inline error array stored on the batch row. */
  private static readonly MAX_PERSISTED_ERRORS = 100;

  constructor(
    private readonly batchesRepo: ScanSyncBatchesRepository,
    private readonly sessionsRepo: ScanSessionsRepository,
    private readonly itemsRepo: ScanItemsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly itemService: ScanItemService,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
  ) {}

  async submit(
    tenantId: string,
    userId: string,
    sessionId: string,
    dto: BulkSyncDto,
  ): Promise<BulkSubmissionResult> {
    const session = await this.requireActiveSession(tenantId, userId, sessionId);
    void session;

    const items = dto.items;
    if (items.length === 0) {
      throw new BusinessException(ErrorCode.INVALID_INPUT, 'No items to sync');
    }
    if (items.length > BulkScanService.MAX_BATCH_SIZE) {
      throw new BusinessException(
        ErrorCode.INVALID_INPUT,
        `Batch too large. Max ${BulkScanService.MAX_BATCH_SIZE} items per submit.`,
      );
    }

    // Idempotency: detect any clientIds we've already processed.
    const clientIds = items.map((i) => i.clientId);
    if (new Set(clientIds).size !== clientIds.length) {
      throw new BusinessException(
        ErrorCode.INVALID_INPUT,
        'Duplicate clientId values within the same batch',
      );
    }

    const batch = await this.batchesRepo.create({
      tenantId,
      sessionId,
      userId,
      status: 'queued',
      totalItems: items.length,
      deviceId: dto.metadata?.deviceId,
      appVersion: dto.metadata?.appVersion,
      metadata: this.metadataAsJson(dto.metadata),
    });

    // v1 inline processing — BE-24 will replace this with a BullMQ enqueue.
    const result = await this.processBatch(batch.id, tenantId, userId, sessionId, items);

    return {
      batchId: batch.id,
      status: result.failed.length > 0 ? 'partial' : 'completed',
      totalItems: items.length,
      estimatedDurationSeconds: 0,
    };
  }

  async getStatus(tenantId: string, batchId: string): Promise<BulkSyncStatus> {
    const batch = await this.batchesRepo.findByIdInTenant(batchId, tenantId);
    if (!batch) throw new DomainNotFoundException('SyncBatch', batchId);
    return this.batchToStatus(batch);
  }

  private batchToStatus(batch: ScanSyncBatchRow): BulkSyncStatus {
    const total = batch.totalItems;
    const processed = batch.processedItems;
    const percentage =
      total === 0
        ? batch.status === 'completed'
          ? 100
          : 0
        : Math.min(100, Math.round((processed / total) * 100));
    return {
      batchId: batch.id,
      status: batch.status,
      progress: {
        total,
        processed,
        succeeded: batch.succeededItems,
        failed: batch.failedItems,
        duplicates: batch.duplicateItems,
        percentage,
      },
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      errors: (batch.errors as BulkSyncError[]) ?? [],
    };
  }

  async listBatches(
    tenantId: string,
    filters: { sessionId?: string; status?: BulkSyncStatus['status'] },
    limit: number,
  ) {
    return this.batchesRepo.listForTenant(tenantId, filters, limit);
  }

  async cancel(tenantId: string, userId: string, batchId: string): Promise<BulkSyncStatus> {
    const batch = await this.batchesRepo.findByIdInTenant(batchId, tenantId);
    if (!batch) throw new DomainNotFoundException('SyncBatch', batchId);
    if (batch.userId !== userId) {
      throw new DomainForbiddenException('Not your batch');
    }
    if (batch.status === 'completed' || batch.status === 'failed' || batch.status === 'cancelled') {
      // Already terminal; return current status from the already-fetched row.
      return this.batchToStatus(batch);
    }
    await this.batchesRepo.update(batchId, {
      status: 'cancelled',
      completedAt: new Date(),
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ScanSyncBatch',
      resourceId: batchId,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'cancel' },
    });
    return this.getStatus(tenantId, batchId);
  }

  /* ─────────────────── internals ─────────────────── */

  /**
   * Drives the per-item loop. Public so BE-24 can call it from the
   * BullMQ worker once that lands; v1 calls it inline from `submit`.
   */
  async processBatch(
    batchId: string,
    tenantId: string,
    userId: string,
    sessionId: string,
    items: BulkScanItemDto[],
  ): Promise<BulkProcessResult> {
    const startMs = Date.now();
    await this.batchesRepo.update(batchId, {
      status: 'processing',
      startedAt: new Date(),
    });

    const successful: BulkProcessResult['successful'] = [];
    const duplicates: BulkProcessResult['duplicates'] = [];
    const failed: BulkSyncError[] = [];

    // Pre-flight: bulk idempotency lookup.
    const clientIds = items.map((i) => i.clientId);
    const existing = await this.idempotency.findExistingMany(sessionId, clientIds);

    for (const item of items) {
      const cached = existing.get(item.clientId);
      if (cached) {
        duplicates.push({
          clientId: item.clientId,
          ean: item.ean,
          existingId: cached.id,
        });
        continue;
      }
      try {
        const result = await this.itemService.recordScan(tenantId, userId, sessionId, {
          clientId: item.clientId,
          ean: item.ean,
          scannedAt: item.scannedAt,
          expiryDate: item.expiryDate,
          manufactureDate: item.manufactureDate,
          batchNumber: item.batchNumber,
          quantity: item.quantity,
          shelfLocation: item.shelfLocation,
          notes: item.notes,
          imageMediaId: item.imageMediaId,
          latitude: item.latitude,
          longitude: item.longitude,
          deviceId: item.deviceId,
        });
        successful.push(result);
      } catch (err) {
        // Race: a concurrent worker inserted the same clientId. The
        // unique partial index throws code `23505`. Reclassify as
        // duplicate so the response stays meaningful.
        const pgCode = (err as { code?: string }).code;
        if (pgCode === '23505') {
          const reread = await this.idempotency.findExisting(sessionId, item.clientId);
          if (reread) {
            duplicates.push({
              clientId: item.clientId,
              ean: item.ean,
              existingId: reread.id,
            });
            continue;
          }
        }
        const errorCode =
          (err as { code?: string }).code ?? (err as { name?: string }).name ?? 'UNKNOWN';
        const message = (err as Error).message ?? 'Unknown error';
        this.logger.warn('bulk-scan.item_failed', {
          batchId,
          clientId: item.clientId,
          ean: item.ean,
          error: { name: (err as Error).name, message },
        });
        failed.push({
          clientId: item.clientId,
          ean: item.ean,
          error: message,
          errorCode: String(errorCode),
        });
      }
    }

    await this.batchesRepo.update(batchId, {
      status: failed.length > 0 ? 'partial' : 'completed',
      completedAt: new Date(),
      processedItems: items.length,
      succeededItems: successful.length,
      duplicateItems: duplicates.length,
      failedItems: failed.length,
      errors: failed.slice(0, BulkScanService.MAX_PERSISTED_ERRORS),
    });

    await this.audit.logAction({
      action: 'IMPORT',
      resourceType: 'ScanSyncBatch',
      resourceId: batchId,
      userId,
      tenantId,
      success: failed.length === 0,
      metadata: {
        sessionId,
        total: items.length,
        succeeded: successful.length,
        duplicates: duplicates.length,
        failed: failed.length,
      },
    });

    return {
      batchId,
      successful,
      duplicates,
      failed,
      totalProcessed: items.length,
      durationMs: Date.now() - startMs,
    };
  }

  private async requireActiveSession(tenantId: string, userId: string, sessionId: string) {
    const session = await this.sessionsRepo.findByIdInTenant(sessionId, tenantId);
    if (!session) throw new DomainNotFoundException('ScanSession', sessionId);
    if (session.userId !== userId) {
      throw new DomainForbiddenException('Not your session');
    }
    if (session.status !== 'active') {
      throw new BusinessException(
        ErrorCode.SCAN_SESSION_CLOSED,
        'Session must be active for bulk sync',
      );
    }
    return session;
  }

  private metadataAsJson(metadata?: BulkSyncMetadataDto): Record<string, unknown> {
    if (!metadata) return {};
    return {
      deviceId: metadata.deviceId,
      appVersion: metadata.appVersion,
      syncedAt: metadata.syncedAt?.toISOString(),
      offlineDurationSeconds: metadata.offlineDurationSeconds,
    };
  }
}
