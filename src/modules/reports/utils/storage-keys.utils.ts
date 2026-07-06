import { createHash, randomUUID } from 'crypto';

import { slugifyForFilename } from './format.utils';
import type { ReportFormat } from '../types/export.types';

/**
 * BE-21 — S3 key + checksum + filename derivations.
 *
 * The key shape is intentional:
 *
 *   tenants/<tenantId>/reports/<reportId>/<isoDate>/<random>-<slug>.<ext>
 *
 *   - `tenantId` first so a single S3 lifecycle/IAM policy can scope
 *     by tenant prefix when we move to per-tenant retention.
 *   - `reportId` next so all artefacts of a single generation live
 *     under one prefix — easy purge.
 *   - `isoDate` (yyyy-mm-dd) clusters files by day for cost reports.
 *   - `random` prevents collisions on retries that didn't reach the
 *     repo `unique(reportId, format)` constraint.
 *   - `slug` is the report title for human-friendly object listings.
 */

const FORMAT_TO_EXT: Record<ReportFormat, string> = {
  pdf: 'pdf',
  xlsx: 'xlsx',
  csv: 'csv',
  json: 'json',
};

const FORMAT_TO_CONTENT_TYPE: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

export interface BuildKeyArgs {
  tenantId: string;
  reportId: string;
  format: ReportFormat;
  title: string;
  /**
   * Bring-your-own random suffix (test determinism). Defaults to a
   * fresh `crypto.randomUUID()`.
   */
  randomSeed?: string;
  /** Bring-your-own clock (test determinism). */
  now?: Date;
}

export interface BuiltKey {
  s3Key: string;
  fileName: string;
  contentType: string;
  extension: string;
}

export function extensionFor(format: ReportFormat): string {
  return FORMAT_TO_EXT[format];
}

export function contentTypeFor(format: ReportFormat): string {
  return FORMAT_TO_CONTENT_TYPE[format];
}

export function buildReportKey(args: BuildKeyArgs): BuiltKey {
  const ext = FORMAT_TO_EXT[args.format];
  const slug = slugifyForFilename(args.title);
  const random = (args.randomSeed ?? randomUUID()).replace(/-/g, '').slice(0, 8);
  const day = (args.now ?? new Date()).toISOString().slice(0, 10);

  const s3Key = [
    'tenants',
    args.tenantId,
    'reports',
    args.reportId,
    day,
    `${random}-${slug}.${ext}`,
  ].join('/');

  return {
    s3Key,
    fileName: `${slug}.${ext}`,
    contentType: FORMAT_TO_CONTENT_TYPE[args.format],
    extension: ext,
  };
}

/**
 * SHA-256 checksum used to pin the artefact identity in
 * `report_files.checksum`. Checked at download time before serving
 * the presigned URL so a tampered S3 object never reaches a client.
 */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Compute an `expires_at` timestamp, defaulting to 90 days. Caller
 * may override per-export — useful for one-off generations that
 * shouldn't accumulate.
 */
export function computeExpiresAt(retentionDays = 90, now: Date = new Date()): Date {
  const ms = retentionDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() + ms);
}
