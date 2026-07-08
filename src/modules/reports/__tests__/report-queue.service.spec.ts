import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ReportsRepository } from '../repositories/reports.repository';
import { ReportGeneratorService } from '../services/report-generator.service';
import { ReportQueueService } from '../services/report-queue.service';
import type { ReportData, ReportType } from '../types/report.types';
import type { IExportFacade } from '../types/queue.types';

const TENANT = 'tenant-1';
const USER = 'user-1';

const baseReportRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 'rpt-1',
    tenantId: TENANT,
    storeId: null,
    type: 'expiry-summary' as ReportType,
    title: 'expiry-summary (2026-04-01 → 2026-04-30)',
    status: 'pending',
    parameters: {
      type: 'expiry-summary',
      formats: ['json', 'csv'],
      dateRange: {
        from: new Date('2026-04-01T00:00:00Z'),
        to: new Date('2026-04-30T00:00:00Z'),
      },
    },
    requestedBy: USER,
    ...over,
  }) as unknown as Awaited<ReturnType<ReportsRepository['findById']>>;

const buildAudit = (): AuditLogService =>
  ({
    logAction: jest.fn(async () => undefined),
  }) as unknown as AuditLogService;

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const sampleData: ReportData = {
  summary: { total: 5, red: 1, yellow: 2, green: 2 },
  rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
  generatedAt: new Date('2026-04-30T01:00:00Z'),
};

const buildExporter = (override: Partial<IExportFacade> = {}): IExportFacade => ({
  exportData: jest.fn(async (req) => ({
    reportId: req.reportId,
    files: req.formats.map((format, i) => ({
      id: `f-${i}`,
      reportId: req.reportId,
      format,
      s3Key: `s3/${req.reportId}.${format}`,
      fileName: `report.${format}`,
      contentType: 'application/octet-stream',
      sizeBytes: 1024,
      checksum: 'abc',
      expiresAt: new Date(Date.now() + 86_400_000),
    })),
    totalSizeBytes: 1024 * req.formats.length,
    durationMs: 5,
  })),
  ...override,
});

describe('ReportQueueService.enqueue', () => {
  it('runs the generator, hands data to the exporter, marks the report completed', async () => {
    const reportsRepo = {
      findById: jest.fn(async () => baseReportRow()),
      updateStatus: jest.fn(async () => undefined),
    } as unknown as ReportsRepository;
    const generator = {
      run: jest.fn(async () => sampleData),
    } as unknown as ReportGeneratorService;
    const exporter = buildExporter();
    const audit = buildAudit();

    const svc = new ReportQueueService(reportsRepo, generator, buildLogger(), audit, exporter);

    await svc.enqueue('rpt-1');

    expect(generator.run as jest.Mock).toHaveBeenCalledTimes(1);
    expect(exporter.exportData as jest.Mock).toHaveBeenCalledTimes(1);

    const statusCalls = (reportsRepo.updateStatus as jest.Mock).mock.calls;
    expect(statusCalls[0][1]).toBe('generating');
    expect(statusCalls[1][1]).toBe('completed');
    const completedExtra = statusCalls[1][2];
    expect(completedExtra.rowCount).toBe(5);
    expect(completedExtra.summary.total).toBe(5);

    const auditCall = (audit.logAction as jest.Mock).mock.calls.at(-1)?.[0];
    expect(auditCall.metadata.formatsBuilt).toEqual(['json', 'csv']);
    expect(auditCall.metadata.formatsFailed).toEqual([]);
  });

  it('marks the report failed when the generator throws', async () => {
    const reportsRepo = {
      findById: jest.fn(async () => baseReportRow()),
      updateStatus: jest.fn(async () => undefined),
    } as unknown as ReportsRepository;
    const generator = {
      run: jest.fn(async () => {
        throw new Error('database is on fire');
      }),
    } as unknown as ReportGeneratorService;
    const exporter = buildExporter();

    const svc = new ReportQueueService(
      reportsRepo,
      generator,
      buildLogger(),
      buildAudit(),
      exporter,
    );

    await expect(svc.enqueue('rpt-1')).rejects.toThrow('database is on fire');
    const statusCalls = (reportsRepo.updateStatus as jest.Mock).mock.calls;
    const lastCall = statusCalls[statusCalls.length - 1];
    expect(lastCall[1]).toBe('failed');
    expect(lastCall[2].errorMessage).toBe('database is on fire');
    expect(exporter.exportData as jest.Mock).not.toHaveBeenCalled();
  });

  it('still marks completed even if the exporter rejects', async () => {
    const reportsRepo = {
      findById: jest.fn(async () => baseReportRow()),
      updateStatus: jest.fn(async () => undefined),
    } as unknown as ReportsRepository;
    const generator = {
      run: jest.fn(async () => sampleData),
    } as unknown as ReportGeneratorService;
    const exporter = buildExporter({
      exportData: jest.fn(async () => {
        throw new Error('S3 down');
      }),
    });
    const audit = buildAudit();
    const svc = new ReportQueueService(reportsRepo, generator, buildLogger(), audit, exporter);
    await svc.enqueue('rpt-1');
    const lastStatus = (reportsRepo.updateStatus as jest.Mock).mock.calls.at(-1);
    expect(lastStatus?.[1]).toBe('completed');
    const auditCall = (audit.logAction as jest.Mock).mock.calls.at(-1)?.[0];
    expect(auditCall.metadata.formatsBuilt).toEqual([]);
    expect(auditCall.metadata.formatsFailed).toEqual(['json', 'csv']);
  });

  it('skips work when the report is already cancelled', async () => {
    const reportsRepo = {
      findById: jest.fn(async () => baseReportRow({ status: 'cancelled' })),
      updateStatus: jest.fn(async () => undefined),
    } as unknown as ReportsRepository;
    const generator = {
      run: jest.fn(),
    } as unknown as ReportGeneratorService;
    const exporter = buildExporter();

    const svc = new ReportQueueService(
      reportsRepo,
      generator,
      buildLogger(),
      buildAudit(),
      exporter,
    );

    await svc.enqueue('rpt-1');
    expect(generator.run as jest.Mock).not.toHaveBeenCalled();
    expect(exporter.exportData as jest.Mock).not.toHaveBeenCalled();
    expect(reportsRepo.updateStatus as jest.Mock).not.toHaveBeenCalled();
  });

  it('throws when the report row does not exist', async () => {
    const reportsRepo = {
      findById: jest.fn(async () => null),
      updateStatus: jest.fn(),
    } as unknown as ReportsRepository;
    const svc = new ReportQueueService(
      reportsRepo,
      { run: jest.fn() } as unknown as ReportGeneratorService,
      buildLogger(),
      buildAudit(),
      buildExporter(),
    );
    await expect(svc.enqueue('missing')).rejects.toThrow(/Report not found/);
  });

  it('still completes when no exporter is bound', async () => {
    const reportsRepo = {
      findById: jest.fn(async () => baseReportRow()),
      updateStatus: jest.fn(async () => undefined),
    } as unknown as ReportsRepository;
    const generator = {
      run: jest.fn(async () => sampleData),
    } as unknown as ReportGeneratorService;
    const audit = buildAudit();
    const svc = new ReportQueueService(
      reportsRepo,
      generator,
      buildLogger(),
      audit,
      // no exporter
    );
    await svc.enqueue('rpt-1');
    const lastStatus = (reportsRepo.updateStatus as jest.Mock).mock.calls.at(-1);
    expect(lastStatus?.[1]).toBe('completed');
    const auditCall = (audit.logAction as jest.Mock).mock.calls.at(-1)?.[0];
    expect(auditCall.metadata.formatsBuilt).toEqual([]);
  });
});
