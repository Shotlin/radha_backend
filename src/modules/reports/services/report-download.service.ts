import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ReportFilesRepository } from '../repositories/report-files.repository';
import { type IReportDownloadService, type ReportFormat } from '../types/export.types';

import { ReportStorageService } from './report-storage.service';

/**
 * BE-21 — Mints presigned download URLs for tracked report
 * artefacts.
 *
 * Validation chain (in order):
 *   1. Resolve the file row inside the requesting tenant. Cross-
 *      tenant leakage is impossible because the lookup is keyed on
 *      `(id, tenant_id)` (or `(report_id, tenant_id, format)`).
 *   2. Reject if the file row has no S3 key (still pending).
 *   3. Reject if the file has expired (`expires_at <= now`).
 *   4. Mint the presigned URL via the storage adapter, capping the
 *      requested expiry at the max remaining lifetime.
 *   5. Audit `READ` with `transition: 'download-url'`.
 *   6. Atomically bump the download counter (no read-modify-write).
 */
@Injectable()
export class ReportDownloadService implements IReportDownloadService {
  /** Hard cap on a single presigned URL's TTL (7 days). */
  private static readonly MAX_TTL_SECONDS = 7 * 24 * 3600;
  /** Default TTL when caller doesn't specify (24 h). */
  private static readonly DEFAULT_TTL_SECONDS = 24 * 3600;

  constructor(
    private readonly filesRepo: ReportFilesRepository,
    private readonly storage: ReportStorageService,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
  ) {}

  async getDownloadUrl(
    fileId: string,
    tenantId: string,
    expirySeconds = ReportDownloadService.DEFAULT_TTL_SECONDS,
  ): Promise<{ url: string; expiresAt: Date; fileName: string }> {
    const file = await this.filesRepo.findByIdInTenant(fileId, tenantId);
    if (!file) throw new DomainNotFoundException('ReportFile', fileId);
    return this.mintFor(
      file.id,
      tenantId,
      file.fileKey,
      file.fileName,
      file.expiresAt,
      file.format as ReportFormat,
      expirySeconds,
      file.reportId,
    );
  }

  async getDownloadUrlByFormat(
    reportId: string,
    tenantId: string,
    format: ReportFormat,
    expirySeconds = ReportDownloadService.DEFAULT_TTL_SECONDS,
  ): Promise<{ url: string; expiresAt: Date; fileName: string }> {
    const file = await this.filesRepo.findByReportFormat(reportId, tenantId, format);
    if (!file) throw new DomainNotFoundException('ReportFile', `${reportId}:${format}`);
    return this.mintFor(
      file.id,
      tenantId,
      file.fileKey,
      file.fileName,
      file.expiresAt,
      format,
      expirySeconds,
      reportId,
    );
  }

  /* ─────────────────── internals ─────────────────── */

  private async mintFor(
    fileId: string,
    tenantId: string,
    fileKey: string | null,
    fileName: string,
    fileExpiresAt: Date | null,
    format: ReportFormat,
    requestedTtl: number,
    reportId: string,
  ): Promise<{ url: string; expiresAt: Date; fileName: string }> {
    if (!fileKey) {
      throw new BusinessException(ErrorCode.RESOURCE_GONE, 'Report artefact is not yet uploaded');
    }

    const now = new Date();
    if (fileExpiresAt && fileExpiresAt.getTime() <= now.getTime()) {
      throw new BusinessException(ErrorCode.RESOURCE_GONE, 'Report artefact has expired', {
        metadata: { expiredAt: fileExpiresAt.toISOString() },
      });
    }

    // Cap requested TTL so a presigned URL never outlives the
    // file-row retention. If the user asked for 7 days but the file
    // expires in 3 hours, we issue a 3-hour URL.
    const remainingSeconds = fileExpiresAt
      ? Math.max(60, Math.floor((fileExpiresAt.getTime() - now.getTime()) / 1000))
      : ReportDownloadService.MAX_TTL_SECONDS;

    const ttl = Math.min(
      Math.max(60, requestedTtl),
      ReportDownloadService.MAX_TTL_SECONDS,
      remainingSeconds,
    );

    const url = await this.storage.getDownloadUrl(fileKey, ttl);
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    await this.filesRepo.incrementDownloadCount(fileId, tenantId);
    await this.audit.logAction({
      action: 'READ',
      resourceType: 'ReportFile',
      resourceId: fileId,
      tenantId,
      userId: '',
      success: true,
      metadata: {
        transition: 'download-url',
        format,
        ttlSeconds: ttl,
        reportId,
      },
    });

    this.logger.info('reports.download.issued', {
      fileId,
      tenantId,
      reportId,
      format,
      ttlSeconds: ttl,
    });

    return { url, expiresAt, fileName };
  }
}
