import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { CsvExporterService } from '../exporters/csv-exporter.service';
import { ExcelExporterService } from '../exporters/excel-exporter.service';
import { ExportService } from '../exporters/export.service';
import { PdfExporterService } from '../exporters/pdf-exporter.service';
import { ReportFilesRepository } from '../repositories/report-files.repository';
import { ReportStorageService } from '../services/report-storage.service';
import type { ExportRequest } from '../types/export.types';
import { sha256Hex } from '../utils/storage-keys.utils';

/**
 * Integration-style spec — wires the *real* CsvExporterService into
 * the orchestrator with stubs for storage / repo / audit. Validates
 * end-to-end behaviour without touching S3 or the database.
 *
 * Excel and PDF use stubbed `__setModuleLoader` to avoid pulling
 * `exceljs` / `pdfkit` at unit-test time. The orchestrator path,
 * however, is fully exercised: hashing, key construction, S3 upload
 * delegation, repo upsert, audit emission.
 */

const TENANT = 'tenant-1';
const USER = 'user-1';
const REPORT = '00000000-0000-4000-8000-000000000001';

interface StoredObject {
  key: string;
  body: Buffer;
  contentType: string;
}

const mkStorage = (objects: StoredObject[]): ReportStorageService =>
  ({
    upload: jest.fn(async (key: string, body: Buffer, contentType: string) => {
      objects.push({ key, body, contentType });
      return key;
    }),
    getDownloadUrl: jest.fn(),
    exists: jest.fn(),
    delete: jest.fn(),
  }) as unknown as ReportStorageService;

const mkRepo = (rows: Array<Record<string, unknown>>): ReportFilesRepository =>
  ({
    upsert: jest.fn(async (data: Record<string, unknown>) => {
      const row = { id: `f${rows.length + 1}`, ...data };
      rows.push(row);
      return row;
    }),
  }) as unknown as ReportFilesRepository;

const mkAudit = (entries: Array<Record<string, unknown>>): AuditLogService =>
  ({
    logAction: jest.fn(async (entry: Record<string, unknown>) => {
      entries.push(entry);
    }),
  }) as unknown as AuditLogService;

const mkLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describe('Export pipeline (integration)', () => {
  it('end-to-end CSV export uploads a real, formula-sanitised file', async () => {
    const stored: StoredObject[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];

    const csv = new CsvExporterService();
    const excel = new ExcelExporterService(mkLogger());
    const pdf = new PdfExporterService(mkLogger());

    // Stub the heavy loaders so accidental misuse of xlsx/pdf
    // surfaces as a test failure, not a missing-package crash.
    excel.__setModuleLoader(async () => {
      throw new Error('exceljs should not be invoked in this test');
    });
    pdf.__setModuleLoader(async () => {
      throw new Error('pdfkit should not be invoked in this test');
    });

    const svc = new ExportService(
      excel,
      pdf,
      csv,
      mkStorage(stored),
      mkRepo(rows),
      mkLogger(),
      mkAudit(audits),
    );

    const request: ExportRequest = {
      reportId: REPORT,
      tenantId: TENANT,
      formats: ['csv'],
      data: {
        rows: [
          { ean: '8901030789885', name: 'Maggi', status: 'green' },
          { ean: '=cmd|/c calc', name: 'evil row', status: 'red' },
        ],
      },
      options: {
        title: 'Pipeline test',
        generatedAt: new Date('2026-06-01T00:00:00Z'),
        generatedBy: USER,
        tenantName: 'Acme',
      },
    };

    const result = await svc.exportData(request, USER);

    // 1. One artefact uploaded.
    expect(stored).toHaveLength(1);
    const artefact = stored[0]!;

    // 2. Tenant- and report-scoped key path.
    expect(artefact.key).toMatch(`tenants/${TENANT}/reports/${REPORT}/`);
    expect(artefact.contentType).toMatch(/^text\/csv/);

    // 3. Body is a UTF-8 BOM CSV with formula injection neutralised.
    const text = artefact.body.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("'=cmd|/c calc");
    // First line carries the BOM + header.
    const firstLine = text.split('\r\n')[0]!;
    expect(firstLine.slice(1)).toBe('ean,name,status');

    // 4. Result checksum matches a fresh hash of the body.
    expect(result.files[0]!.checksum).toBe(sha256Hex(artefact.body));
    expect(result.files[0]!.sizeBytes).toBe(artefact.body.length);

    // 5. Repo recorded the artefact with the same key.
    expect(rows).toHaveLength(1);
    expect((rows[0] as { fileKey: string }).fileKey).toBe(artefact.key);

    // 6. Audit log fired EXPORT once.
    expect(audits).toHaveLength(1);
    expect((audits[0] as { action: string }).action).toBe('EXPORT');
  });

  it('JSON export bundles options and data into a self-describing artefact', async () => {
    const stored: StoredObject[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];

    const csv = new CsvExporterService();
    const excel = new ExcelExporterService(mkLogger());
    const pdf = new PdfExporterService(mkLogger());

    const svc = new ExportService(
      excel,
      pdf,
      csv,
      mkStorage(stored),
      mkRepo(rows),
      mkLogger(),
      mkAudit(audits),
    );

    await svc.exportData(
      {
        reportId: REPORT,
        tenantId: TENANT,
        formats: ['json'],
        data: { rows: [{ a: 1 }], summary: { total: 1 } },
        options: {
          title: 'Pipeline JSON',
          generatedAt: new Date('2026-06-01T00:00:00Z'),
          generatedBy: USER,
          tenantName: 'Acme',
        },
      },
      USER,
    );

    expect(stored).toHaveLength(1);
    const parsed = JSON.parse(stored[0]!.body.toString('utf8'));
    expect(parsed.title).toBe('Pipeline JSON');
    expect(parsed.data.rows).toEqual([{ a: 1 }]);
    expect(parsed.data.summary).toEqual({ total: 1 });
  });
});
