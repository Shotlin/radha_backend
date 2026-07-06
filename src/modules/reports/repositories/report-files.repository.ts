import { Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { type NewReportFile, type ReportFileRow, reportFiles } from '@/db/schema/reports';

import type { ReportFormat } from '../types/export.types';

/**
 * BE-21 — `report_files` repository.
 *
 * Sits over the BE-20 schema (`server/src/db/schema/reports.ts`).
 * That schema file already lives in the repo — BE-20 will own its
 * migration and barrel registration. We import the `reportFiles`
 * symbol directly so this module doesn't depend on the schema barrel
 * being updated yet.
 *
 * Concurrency model:
 *   - Generation is idempotent. Re-runs UPSERT on the
 *     `(report_id, format)` partial unique index already declared in
 *     the schema. The repo exposes `upsert()` for that purpose.
 *   - Reads are scoped by `(id, tenant_id)` or
 *     `(report_id, tenant_id, format)` to prevent cross-tenant
 *     leakage even if a stale id is presented.
 */
@Injectable()
export class ReportFilesRepository extends BaseRepository<
  typeof reportFiles,
  ReportFileRow,
  NewReportFile,
  Partial<NewReportFile>
> {
  constructor(db: DbService) {
    super(db.getDb(), reportFiles, 'report_files');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ReportFileRow | null> {
    const [row] = await this.db
      .select()
      .from(reportFiles)
      .where(and(eq(reportFiles.id, id), eq(reportFiles.tenantId, tenantId)))
      .limit(1);
    return (row as ReportFileRow | undefined) ?? null;
  }

  async findByReportFormat(
    reportId: string,
    tenantId: string,
    format: ReportFormat,
  ): Promise<ReportFileRow | null> {
    const [row] = await this.db
      .select()
      .from(reportFiles)
      .where(
        and(
          eq(reportFiles.reportId, reportId),
          eq(reportFiles.tenantId, tenantId),
          eq(reportFiles.format, format),
        ),
      )
      .limit(1);
    return (row as ReportFileRow | undefined) ?? null;
  }

  async listForReport(reportId: string, tenantId: string): Promise<ReportFileRow[]> {
    return (await this.db
      .select()
      .from(reportFiles)
      .where(
        and(eq(reportFiles.reportId, reportId), eq(reportFiles.tenantId, tenantId)),
      )) as ReportFileRow[];
  }

  /**
   * Idempotent insert keyed on the (report_id, format) partial
   * unique index defined on `report_files`. A retried generation
   * replaces the previous row's S3 key, checksum, and bytes.
   */
  async upsert(data: NewReportFile): Promise<ReportFileRow> {
    const [row] = await this.db
      .insert(reportFiles)
      .values(data)
      .onConflictDoUpdate({
        target: [reportFiles.reportId, reportFiles.format],
        set: {
          fileKey: data.fileKey ?? null,
          fileName: data.fileName,
          contentType: data.contentType,
          fileSize: data.fileSize ?? null,
          checksum: data.checksum ?? null,
          expiresAt: data.expiresAt ?? null,
          metadata: data.metadata ?? {},
        },
      })
      .returning();
    return row as ReportFileRow;
  }

  /**
   * Atomic counter — used by `ReportDownloadService` to mark a file
   * as served without read-modify-write. Stays concurrency-safe even
   * if two clients hit the same URL at the same instant.
   */
  async incrementDownloadCount(id: string, tenantId: string): Promise<void> {
    await this.db
      .update(reportFiles)
      .set({
        metadata: sql`coalesce(${reportFiles.metadata}, '{}'::jsonb) ||
                       jsonb_build_object(
                         'downloadCount',
                         coalesce((${reportFiles.metadata} ->> 'downloadCount')::int, 0) + 1,
                         'lastDownloadedAt', to_jsonb(now())
                       )`,
      })
      .where(and(eq(reportFiles.id, id), eq(reportFiles.tenantId, tenantId)));
  }

  /**
   * Used by the BE-24 cleanup scheduler to find expired artefacts
   * and remove them from S3 + DB. Guarded by tenant where possible.
   */
  async findExpired(now: Date = new Date()): Promise<ReportFileRow[]> {
    return (await this.db
      .select()
      .from(reportFiles)
      .where(lt(reportFiles.expiresAt, now))) as ReportFileRow[];
  }
}
