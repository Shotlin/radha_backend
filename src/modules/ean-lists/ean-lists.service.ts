import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainNotFoundException,
  ValidationException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  CreateEanListDto,
  ImportInlineDto,
  ListEanListsQueryDto,
  UpdateEanListDto,
} from './dto/ean-lists.dto';
import { EanListItemsRepository } from './repositories/ean-list-items.repository';
import { EanListsRepository } from './repositories/ean-lists.repository';
import { ImportBatchesRepository } from './repositories/import-batches.repository';
import { ImportErrorsRepository } from './repositories/import-errors.repository';
import { ImportProcessorService } from './services/import-processor.service';
import type {
  EanList,
  EanListItem,
  EanListWithStats,
  ImportBatch,
  ImportError,
  ImportInitResult,
  ImportStatus,
} from './types/import.types';
import { validateAgainstDeclaredType } from './utils/file-detector.utils';

/**
 * BE-15 — Top-level EAN list service.
 *
 * Owns the public surface for the controller. Coordinates the
 * repositories, the import processor, and the audit log.
 */
@Injectable()
export class EanListsService {
  constructor(
    private readonly listsRepo: EanListsRepository,
    private readonly itemsRepo: EanListItemsRepository,
    private readonly batchesRepo: ImportBatchesRepository,
    private readonly errorsRepo: ImportErrorsRepository,
    private readonly importer: ImportProcessorService,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  /* ─────────────────── List CRUD ─────────────────── */

  async create(tenantId: string, userId: string, dto: CreateEanListDto): Promise<EanList> {
    const created = await this.listsRepo.create({
      tenantId,
      storeId: dto.storeId ?? null,
      name: dto.name,
      description: dto.description,
      status: 'draft',
      createdBy: userId,
    });
    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'EanList',
      resourceId: created.id,
      userId,
      tenantId,
      success: true,
      metadata: { name: dto.name, storeId: dto.storeId ?? null },
    });
    return created;
  }

  async findById(tenantId: string, id: string): Promise<EanListWithStats> {
    const row = await this.listsRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('EanList', id);
    const matchedItems = await this.itemsRepo.count({
      listId: id,
    } as unknown as Record<string, unknown>);
    return {
      ...row,
      matchedItems: matchedItems,
      unmatchedItems: Math.max(row.totalItems - matchedItems, 0),
    } as EanListWithStats;
  }

  async list(tenantId: string, query: ListEanListsQueryDto): Promise<EanList[]> {
    return this.listsRepo.listForTenant(
      tenantId,
      { storeId: query.storeId, status: query.status },
      query.limit,
    );
  }

  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateEanListDto,
  ): Promise<EanList> {
    const existing = await this.listsRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('EanList', id);
    const updated = await this.listsRepo.update(id, {
      name: dto.name,
      description: dto.description,
      updatedBy: userId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'EanList',
      resourceId: id,
      userId,
      tenantId,
      success: true,
    });
    return updated;
  }

  async softDelete(tenantId: string, userId: string, id: string): Promise<void> {
    const existing = await this.listsRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('EanList', id);
    if (existing.status === 'active') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot delete an active list. Deactivate it first.',
      );
    }
    await this.listsRepo.softDelete(id, userId);
    await this.audit.logAction({
      action: 'DELETE',
      resourceType: 'EanList',
      resourceId: id,
      userId,
      tenantId,
      success: true,
    });
  }

  /* ─────────────────── Activation ─────────────────── */

  async activate(tenantId: string, userId: string, id: string): Promise<EanList> {
    const existing = await this.listsRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('EanList', id);
    if (existing.status === 'active') return existing;

    // Archive any currently-active lists in the same scope.
    await this.listsRepo.deactivateAllForScope(tenantId, existing.storeId);

    const updated = await this.listsRepo.update(id, {
      status: 'active',
      activatedAt: new Date(),
      deactivatedAt: null,
      updatedBy: userId,
    });

    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'EanList',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'activate' },
    });
    return updated;
  }

  async deactivate(tenantId: string, userId: string, id: string): Promise<EanList> {
    const existing = await this.listsRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('EanList', id);
    if (existing.status !== 'active') return existing;
    const updated = await this.listsRepo.update(id, {
      status: 'archived',
      deactivatedAt: new Date(),
      updatedBy: userId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'EanList',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'deactivate' },
    });
    return updated;
  }

  /* ─────────────────── Import flow ─────────────────── */

  async importInline(
    tenantId: string,
    userId: string,
    listId: string,
    dto: ImportInlineDto,
  ): Promise<ImportInitResult> {
    const list = await this.listsRepo.findByIdInTenant(listId, tenantId);
    if (!list) throw new DomainNotFoundException('EanList', listId);

    const buffer = Buffer.from(dto.fileBase64, 'base64');
    const detection = validateAgainstDeclaredType(buffer, dto.fileType);
    if (!detection.ok) {
      throw new ValidationException(detection.reason, {
        field: 'fileType',
        value: dto.fileType,
      });
    }

    const batchId = randomUUID();
    await this.batchesRepo.create({
      id: batchId,
      tenantId,
      listId,
      importedBy: userId,
      fileName: dto.fileName,
      fileType: dto.fileType,
      fileSize: buffer.length,
      status: 'queued',
    });

    // v1: synchronous in-request processing. BE-24 will offload this
    // to a BullMQ job when files routinely exceed 5K rows.
    await this.importer.processImport(batchId, buffer);

    const finalBatch = await this.batchesRepo.findById(batchId);
    await this.audit.logAction({
      action: 'IMPORT',
      resourceType: 'EanList',
      resourceId: listId,
      userId,
      tenantId,
      success: finalBatch?.status === 'completed',
      metadata: { batchId, status: finalBatch?.status, fileName: dto.fileName },
    });
    return {
      batchId,
      status: (finalBatch?.status ?? 'completed') as ImportInitResult['status'],
      estimatedRows: finalBatch?.totalRows ?? 0,
      estimatedDurationSeconds: 0,
    };
  }

  async getImportStatus(tenantId: string, batchId: string): Promise<ImportStatus> {
    const batch = await this.batchesRepo.findByIdInTenant(batchId, tenantId);
    if (!batch) throw new DomainNotFoundException('ImportBatch', batchId);
    const totalRows = batch.totalRows;
    const processedRows = batch.processedRows;
    const percentage =
      totalRows === 0
        ? batch.status === 'completed'
          ? 100
          : 0
        : Math.min(100, Math.round((processedRows / totalRows) * 100));
    return {
      batchId: batch.id,
      status: batch.status,
      progress: {
        totalRows,
        processedRows,
        validRows: batch.validRows,
        invalidRows: batch.invalidRows,
        percentage,
      },
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      errorMessage: batch.errorMessage,
    };
  }

  async cancelImport(tenantId: string, userId: string, batchId: string): Promise<ImportBatch> {
    const batch = await this.batchesRepo.findByIdInTenant(batchId, tenantId);
    if (!batch) throw new DomainNotFoundException('ImportBatch', batchId);
    if (batch.status === 'completed' || batch.status === 'failed' || batch.status === 'cancelled') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot cancel batch in status ${batch.status}`,
      );
    }
    const updated = await this.batchesRepo.update(batchId, {
      status: 'cancelled',
      completedAt: new Date(),
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ImportBatch',
      resourceId: batchId,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'cancel' },
    });
    return updated;
  }

  async getImportErrors(tenantId: string, batchId: string, limit: number): Promise<ImportError[]> {
    const batch = await this.batchesRepo.findByIdInTenant(batchId, tenantId);
    if (!batch) throw new DomainNotFoundException('ImportBatch', batchId);
    return this.errorsRepo.listForBatch(batchId, limit);
  }

  async downloadErrorsCsv(tenantId: string, batchId: string): Promise<string> {
    const errors = await this.getImportErrors(tenantId, batchId, 10_000);
    const headers = ['rowNumber', 'errors', 'rawData'];
    const lines = [headers.join(',')];
    for (const e of errors) {
      const rowNumberCell = String(e.rowNumber);
      const errorsCell = csvEscape(e.errors.join('; '));
      const rawDataCell = csvEscape(JSON.stringify(e.rawData ?? {}));
      lines.push([rowNumberCell, errorsCell, rawDataCell].join(','));
    }
    return lines.join('\n');
  }

  /* ─────────────────── Items query ─────────────────── */

  async listItems(tenantId: string, listId: string, limit: number): Promise<EanListItem[]> {
    const list = await this.listsRepo.findByIdInTenant(listId, tenantId);
    if (!list) throw new DomainNotFoundException('EanList', listId);
    return this.itemsRepo.listByList(listId, limit);
  }
}

const csvEscape = (value: string): string => {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};
