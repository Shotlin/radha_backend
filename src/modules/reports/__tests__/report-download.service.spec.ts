import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ReportFilesRepository } from '../repositories/report-files.repository';
import { ReportDownloadService } from '../services/report-download.service';
import { ReportStorageService } from '../services/report-storage.service';
import type { ReportFormat } from '../types/export.types';

const TENANT = 'tenant-1';
const REPORT = 'report-1';

interface FileLike {
  id: string;
  reportId: string;
  tenantId: string;
  format: ReportFormat;
  fileKey: string | null;
  fileName: string;
  expiresAt: Date | null;
}

const buildFile = (over: Partial<FileLike> = {}): FileLike => ({
  id: 'file-1',
  reportId: REPORT,
  tenantId: TENANT,
  format: 'pdf',
  fileKey: 'tenants/tenant-1/reports/report-1/2026-06-01/abc-test.pdf',
  fileName: 'test.pdf',
  expiresAt: new Date(Date.now() + 86_400_000), // +1 day
  ...over,
});

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildAudit = (): AuditLogService =>
  ({ logAction: jest.fn(async () => undefined) }) as unknown as AuditLogService;

const buildSvc = (
  options: {
    fileById?: FileLike | null;
    fileByFormat?: FileLike | null;
    presignedUrl?: string;
  } = {},
) => {
  const filesRepo = {
    findByIdInTenant: jest.fn(async () => options.fileById ?? null),
    findByReportFormat: jest.fn(async () => options.fileByFormat ?? null),
    incrementDownloadCount: jest.fn(async () => undefined),
  } as unknown as ReportFilesRepository;
  const storage = {
    getDownloadUrl: jest.fn(
      async (_key: string, ttl: number) => options.presignedUrl ?? `https://s3.example/${ttl}`,
    ),
  } as unknown as ReportStorageService;
  const audit = buildAudit();
  const svc = new ReportDownloadService(filesRepo, storage, buildLogger(), audit);
  return { svc, filesRepo, storage, audit };
};

describe('ReportDownloadService.getDownloadUrl', () => {
  it('throws DomainNotFoundException when the file is missing', async () => {
    const { svc } = buildSvc({ fileById: null });
    await expect(svc.getDownloadUrl('missing', TENANT)).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('throws RESOURCE_GONE when the file row has no S3 key yet', async () => {
    const { svc } = buildSvc({ fileById: buildFile({ fileKey: null }) });
    await expect(svc.getDownloadUrl('file-1', TENANT)).rejects.toMatchObject({
      code: ErrorCode.RESOURCE_GONE,
    });
  });

  it('throws RESOURCE_GONE when the file has expired', async () => {
    const { svc } = buildSvc({
      fileById: buildFile({ expiresAt: new Date(Date.now() - 1000) }),
    });
    await expect(svc.getDownloadUrl('file-1', TENANT)).rejects.toBeInstanceOf(BusinessException);
  });

  it('mints a presigned URL with the requested TTL', async () => {
    const { svc, storage } = buildSvc({ fileById: buildFile() });
    const result = await svc.getDownloadUrl('file-1', TENANT, 3600);
    expect(storage.getDownloadUrl as jest.Mock).toHaveBeenCalled();
    const ttlArg = (storage.getDownloadUrl as jest.Mock).mock.calls[0]![1];
    expect(ttlArg).toBe(3600);
    expect(result.url).toContain('https://s3.example/');
    expect(result.fileName).toBe('test.pdf');
  });

  it('caps TTL at 7 days', async () => {
    const { svc, storage } = buildSvc({ fileById: buildFile() });
    await svc.getDownloadUrl('file-1', TENANT, 30 * 24 * 3600);
    const ttlArg = (storage.getDownloadUrl as jest.Mock).mock.calls[0]![1];
    expect(ttlArg).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it('caps TTL at the remaining file lifetime', async () => {
    const remainingMs = 60_000; // 60s
    const { svc, storage } = buildSvc({
      fileById: buildFile({
        expiresAt: new Date(Date.now() + remainingMs),
      }),
    });
    await svc.getDownloadUrl('file-1', TENANT, 7 * 24 * 3600);
    const ttlArg = (storage.getDownloadUrl as jest.Mock).mock.calls[0]![1];
    expect(ttlArg).toBeLessThanOrEqual(60);
  });

  it('floors TTL to 60 seconds even with a very-near-expiry file', async () => {
    const { svc, storage } = buildSvc({
      fileById: buildFile({ expiresAt: new Date(Date.now() + 1) }),
    });
    await svc.getDownloadUrl('file-1', TENANT, 3600);
    const ttlArg = (storage.getDownloadUrl as jest.Mock).mock.calls[0]![1];
    expect(ttlArg).toBeGreaterThanOrEqual(60);
  });

  it('atomically increments download counter', async () => {
    const { svc, filesRepo } = buildSvc({ fileById: buildFile() });
    await svc.getDownloadUrl('file-1', TENANT);
    expect(filesRepo.incrementDownloadCount as jest.Mock).toHaveBeenCalledWith('file-1', TENANT);
  });

  it('audits READ with transition=download-url', async () => {
    const { svc, audit } = buildSvc({ fileById: buildFile() });
    await svc.getDownloadUrl('file-1', TENANT);
    const entry = (audit.logAction as jest.Mock).mock.calls[0]![0];
    expect(entry.action).toBe('READ');
    expect(entry.metadata.transition).toBe('download-url');
    expect(entry.tenantId).toBe(TENANT);
  });
});

describe('ReportDownloadService.getDownloadUrlByFormat', () => {
  it('routes through findByReportFormat with tenant scope', async () => {
    const { svc, filesRepo } = buildSvc({ fileByFormat: buildFile() });
    await svc.getDownloadUrlByFormat(REPORT, TENANT, 'pdf');
    expect(filesRepo.findByReportFormat as jest.Mock).toHaveBeenCalledWith(REPORT, TENANT, 'pdf');
  });

  it('throws DomainNotFoundException when no file for the requested format', async () => {
    const { svc } = buildSvc({ fileByFormat: null });
    await expect(svc.getDownloadUrlByFormat(REPORT, TENANT, 'csv')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });
});
