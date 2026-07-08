import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { CsvExporterService } from '../exporters/csv-exporter.service';
import { ExcelExporterService } from '../exporters/excel-exporter.service';
import { ExportService } from '../exporters/export.service';
import { PdfExporterService } from '../exporters/pdf-exporter.service';
import { ReportFilesRepository } from '../repositories/report-files.repository';
import { ReportStorageService } from '../services/report-storage.service';
import type { ExportRequest, ReportDataLoader } from '../types/export.types';

const TENANT = 'tenant-1';
const USER = 'user-1';
const REPORT = '00000000-0000-4000-8000-000000000001';

const buildRequest = (overrides: Partial<ExportRequest> = {}): ExportRequest => ({
  reportId: REPORT,
  tenantId: TENANT,
  formats: ['csv'],
  data: { rows: [{ ean: '8901', name: 'Maggi' }] },
  options: {
    title: 'Test Report',
    generatedAt: new Date('2026-06-01T00:00:00Z'),
    generatedBy: USER,
    tenantName: 'Acme',
  },
  ...overrides,
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
    excelOutput?: Buffer;
    pdfOutput?: Buffer;
    csvOutput?: Buffer;
    dataLoader?: ReportDataLoader;
    repoUpsert?: (data: unknown) => unknown;
  } = {},
) => {
  const audit = buildAudit();
  const logger = buildLogger();

  const excel = {
    generate: jest.fn(async () => options.excelOutput ?? Buffer.from('XLSX_BYTES')),
  } as unknown as ExcelExporterService;
  const pdf = {
    generate: jest.fn(async () => options.pdfOutput ?? Buffer.from('PDF_BYTES')),
  } as unknown as PdfExporterService;
  const csv = {
    generate: jest.fn(async () => options.csvOutput ?? Buffer.from('CSV_BYTES')),
  } as unknown as CsvExporterService;

  const storage = {
    upload: jest.fn(async (key: string) => key),
  } as unknown as ReportStorageService;

  const filesRepo = {
    upsert: jest.fn(async (data: unknown) => {
      const result = options.repoUpsert?.(data) ?? {
        id: 'file-' + Math.random().toString(36).slice(2, 8),
        ...(data as Record<string, unknown>),
      };
      return result;
    }),
  } as unknown as ReportFilesRepository;

  const svc = new ExportService(
    excel,
    pdf,
    csv,
    storage,
    filesRepo,
    logger,
    audit,
    options.dataLoader,
  );
  return { svc, excel, pdf, csv, storage, filesRepo, audit };
};

describe('ExportService.exportData', () => {
  it('renders, uploads, and persists a single CSV artefact', async () => {
    const { svc, csv, storage, filesRepo, audit } = buildSvc();
    const result = await svc.exportData(buildRequest({ formats: ['csv'] }), USER);

    expect(csv.generate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(storage.upload as jest.Mock).toHaveBeenCalledTimes(1);
    expect(filesRepo.upsert as jest.Mock).toHaveBeenCalledTimes(1);
    expect(audit.logAction as jest.Mock).toHaveBeenCalledTimes(1);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.format).toBe('csv');
    expect(result.files[0]!.sizeBytes).toBeGreaterThan(0);
    expect(result.files[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders all formats in parallel', async () => {
    const { svc, excel, pdf, csv } = buildSvc();
    const result = await svc.exportData(
      buildRequest({ formats: ['xlsx', 'pdf', 'csv', 'json'] }),
      USER,
    );
    expect(excel.generate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(pdf.generate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(csv.generate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(result.files.map((f) => f.format)).toEqual(['xlsx', 'pdf', 'csv', 'json']);
  });

  it('deduplicates repeated formats', async () => {
    const { svc, csv } = buildSvc();
    const result = await svc.exportData(buildRequest({ formats: ['csv', 'csv', 'csv'] }), USER);
    expect(csv.generate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(result.files).toHaveLength(1);
  });

  it('rejects when no formats given', async () => {
    const { svc } = buildSvc();
    await expect(svc.exportData(buildRequest({ formats: [] }), USER)).rejects.toThrow();
  });

  it('rejects when an exporter returns an empty buffer', async () => {
    const { svc } = buildSvc({ csvOutput: Buffer.alloc(0) });
    await expect(svc.exportData(buildRequest({ formats: ['csv'] }), USER)).rejects.toThrow(
      /Empty buffer/i,
    );
  });

  it('uses tenant-scoped S3 keys', async () => {
    const { svc, storage } = buildSvc();
    await svc.exportData(buildRequest(), USER);
    const keyArg = (storage.upload as jest.Mock).mock.calls[0]![0] as string;
    expect(keyArg).toMatch(`tenants/${TENANT}/reports/${REPORT}/`);
  });

  it('records EXPORT audit per artefact', async () => {
    const { svc, audit } = buildSvc();
    await svc.exportData(buildRequest({ formats: ['csv', 'pdf'] }), USER);
    expect(audit.logAction as jest.Mock).toHaveBeenCalledTimes(2);
    const firstCall = (audit.logAction as jest.Mock).mock.calls[0]![0];
    expect(firstCall.action).toBe('EXPORT');
    expect(firstCall.tenantId).toBe(TENANT);
    expect(firstCall.metadata.transition).toBe('generated');
  });

  it('honours custom retentionDays in expiresAt', async () => {
    const { svc, filesRepo } = buildSvc();
    const before = Date.now();
    await svc.exportData(buildRequest({ retentionDays: 7 }), USER);
    const upsertArg = (filesRepo.upsert as jest.Mock).mock.calls[0]![0] as {
      expiresAt: Date;
    };
    const expectedExpiry = before + 7 * 24 * 3600 * 1000;
    // Allow generous tolerance — the call took some time.
    expect(upsertArg.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 5000);
    expect(upsertArg.expiresAt.getTime()).toBeLessThan(expectedExpiry + 5000);
  });
});

describe('ExportService.exportReport', () => {
  it('throws a clear error when no ReportDataLoader is registered', async () => {
    const { svc } = buildSvc();
    await expect(svc.exportReport(REPORT, TENANT, ['csv'], USER)).rejects.toThrow(
      /ReportDataLoader is not registered/,
    );
  });

  it('delegates to the registered ReportDataLoader and exports', async () => {
    const dataLoader: ReportDataLoader = {
      load: jest.fn(async () => ({
        data: { rows: [{ a: 1 }] },
        options: {
          title: 'BE-20 generated',
          generatedAt: new Date('2026-06-01T00:00:00Z'),
          generatedBy: USER,
          tenantName: 'Acme',
        },
      })),
    };
    const { svc } = buildSvc({ dataLoader });
    const result = await svc.exportReport(REPORT, TENANT, ['csv'], USER);
    expect(dataLoader.load as jest.Mock).toHaveBeenCalledWith(REPORT, TENANT);
    expect(result.files).toHaveLength(1);
  });
});

describe('ExportService.__contentTypeFor', () => {
  it('exposes the canonical content-type map', () => {
    expect(ExportService.__contentTypeFor('pdf')).toBe('application/pdf');
    expect(ExportService.__contentTypeFor('xlsx')).toMatch(/spreadsheetml/);
    expect(ExportService.__contentTypeFor('csv')).toMatch(/^text\/csv/);
    expect(ExportService.__contentTypeFor('json')).toMatch(/^application\/json/);
  });
});
