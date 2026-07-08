import {
  BusinessException,
  DomainNotFoundException,
  ValidationException,
} from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { DashboardSummaryGenerator } from '../generators/dashboard-summary.generator';
import { ReportFilesRepository } from '../repositories/report-files.repository';
import { ReportsRepository } from '../repositories/reports.repository';
import { ReportsService } from '../reports.service';
import { ReportGeneratorService } from '../services/report-generator.service';
import { ReportQueueService } from '../services/report-queue.service';
import type { DashboardSummary, GenerateReportParams, ReportType } from '../types/report.types';

const TENANT = 'tenant-1';
const USER = 'user-1';

const validParams: GenerateReportParams = {
  type: 'expiry-summary',
  formats: ['xlsx', 'json'],
  storeIds: ['00000000-0000-4000-8000-000000000001'],
  dateRange: {
    from: new Date('2026-04-01T00:00:00Z'),
    to: new Date('2026-04-30T00:00:00Z'),
  },
};

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildAudit = (): AuditLogService =>
  ({
    logAction: jest.fn(async () => undefined),
  }) as unknown as AuditLogService;

const baseReport = (over: Record<string, unknown> = {}) =>
  ({
    id: 'rpt-1',
    tenantId: TENANT,
    storeId: validParams.storeIds?.[0] ?? null,
    type: 'expiry-summary' as ReportType,
    title: 'expiry-summary',
    status: 'completed',
    parameters: validParams,
    requestedBy: USER,
    rowCount: 10,
    summary: { total: 10 },
    errorMessage: null,
    generationDurationMs: 250,
    expiresAt: new Date('2026-07-01T00:00:00Z'),
    createdAt: new Date('2026-04-30T00:00:00Z'),
    ...over,
  }) as never;

const buildSvc = (
  overrides: {
    generatorHas?: boolean;
    reportsRepoStubs?: Partial<ReportsRepository>;
    filesRepoStubs?: Partial<ReportFilesRepository>;
    queueStubs?: Partial<ReportQueueService>;
    dashboardStubs?: Partial<DashboardSummaryGenerator>;
  } = {},
) => {
  const reportsRepo = {
    findById: jest.fn(async (id: string) => baseReport({ id })),
    findByIdInTenant: jest.fn(async () => baseReport()),
    create: jest.fn(async () => baseReport()),
    update: jest.fn(async (id: string, data: Record<string, unknown>) =>
      baseReport({ id, ...data }),
    ),
    listForTenant: jest.fn(async () => [baseReport()]),
    ...overrides.reportsRepoStubs,
  } as unknown as ReportsRepository;

  const filesRepo = {
    listForReport: jest.fn(async () => [
      {
        id: 'f-1',
        reportId: 'rpt-1',
        format: 'xlsx',
        fileName: 'r.xlsx',
        contentType: 'application/octet-stream',
      },
    ]),
    findByReportFormat: jest.fn(async (_id: string, _t: string, format: string) => ({
      id: 'f-1',
      reportId: 'rpt-1',
      format,
      fileName: `r.${format}`,
      contentType: 'application/octet-stream',
      fileSize: 1024,
      checksum: 'abc',
    })),
    ...overrides.filesRepoStubs,
  } as unknown as ReportFilesRepository;

  const generator = {
    has: jest.fn((type: ReportType) =>
      overrides.generatorHas !== undefined
        ? overrides.generatorHas
        : type !== ('mystery' as ReportType),
    ),
    run: jest.fn(),
    supportedTypes: jest.fn(() => []),
  } as unknown as ReportGeneratorService;

  const queue = {
    enqueue: jest.fn(async () => undefined),
    ...overrides.queueStubs,
  } as unknown as ReportQueueService;

  const dashboard = {
    summarise: jest.fn(
      async (): Promise<DashboardSummary> => ({
        storeId: 'store-1',
        dateRange: validParams.dateRange,
        totals: {
          scans: 0,
          sessionsCompleted: 0,
          expiryRecords: 0,
          activeAlerts: 0,
          tasksCompleted: 0,
          tasksOverdue: 0,
        },
        expiry: { green: 0, yellow: 0, red: 0, expired: 0, unknown: 0 },
        scanHealth: { matched: 0, unmatched: 0, matchRate: 0 },
        trends: [],
        topProducts: [],
        topUsers: [],
        generatedAt: new Date(),
      }),
    ),
    ...overrides.dashboardStubs,
  } as unknown as DashboardSummaryGenerator;

  const audit = buildAudit();
  const svc = new ReportsService(
    reportsRepo,
    filesRepo,
    generator,
    queue,
    dashboard,
    buildLogger(),
    audit,
  );
  return { svc, reportsRepo, filesRepo, generator, queue, dashboard, audit };
};

describe('ReportsService.generate', () => {
  it('rejects unknown report types via ValidationException', async () => {
    const { svc } = buildSvc({ generatorHas: false });
    await expect(
      svc.generate(TENANT, USER, { ...validParams, type: 'mystery' as ReportType }),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('rejects dashboard generation through queue (live-only)', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.generate(TENANT, USER, { ...validParams, type: 'dashboard' }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('persists report row, queues processing and audit-logs', async () => {
    const { svc, reportsRepo, queue, audit } = buildSvc();
    const out = await svc.generate(TENANT, USER, validParams);
    expect(out.reportId).toBe('rpt-1');
    expect(reportsRepo.create as jest.Mock).toHaveBeenCalledTimes(1);
    expect(queue.enqueue as jest.Mock).toHaveBeenCalledWith('rpt-1');
    expect(audit.logAction as jest.Mock).toHaveBeenCalled();
    expect(out.formats).toEqual(['xlsx', 'json']);
  });

  it('rethrows when the queue fails', async () => {
    const { svc } = buildSvc({
      queueStubs: {
        enqueue: jest.fn(async () => {
          throw new Error('worker exploded');
        }),
      },
    });
    await expect(svc.generate(TENANT, USER, validParams)).rejects.toThrow('worker exploded');
  });
});

describe('ReportsService.findById / getStatus', () => {
  it('returns the report with file rows attached', async () => {
    const { svc, filesRepo } = buildSvc();
    const out = await svc.findById(TENANT, 'rpt-1');
    expect(out.files).toHaveLength(1);
    expect(filesRepo.listForReport as jest.Mock).toHaveBeenCalledWith('rpt-1', TENANT);
  });

  it('throws when the report is in another tenant', async () => {
    const { svc } = buildSvc({
      reportsRepoStubs: {
        findByIdInTenant: jest.fn(async () => null),
      },
    });
    await expect(svc.findById(TENANT, 'other-tenant-rpt')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('projects status into a stable shape', async () => {
    const { svc } = buildSvc();
    const status = await svc.getStatus(TENANT, 'rpt-1');
    expect(status.status).toBe('completed');
    expect(status.rowCount).toBe(10);
  });
});

describe('ReportsService.getDownloadInfo', () => {
  it('rejects download for non-completed reports', async () => {
    const { svc } = buildSvc({
      reportsRepoStubs: {
        findByIdInTenant: jest.fn(async () => baseReport({ status: 'pending' })),
      },
    });
    await expect(svc.getDownloadInfo(TENANT, USER, 'rpt-1', 'xlsx')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('throws DomainNotFoundException when format row is missing', async () => {
    const { svc } = buildSvc({
      filesRepoStubs: {
        findByReportFormat: jest.fn(async () => null),
      },
    });
    await expect(svc.getDownloadInfo(TENANT, USER, 'rpt-1', 'pdf')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('audit-logs an EXPORT action and returns the file metadata', async () => {
    const { svc, audit } = buildSvc();
    const file = await svc.getDownloadInfo(TENANT, USER, 'rpt-1', 'xlsx');
    expect(file.fileName).toBe('r.xlsx');
    const auditCall = (audit.logAction as jest.Mock).mock.calls[0]![0];
    expect(auditCall.action).toBe('EXPORT');
    expect(auditCall.resourceType).toBe('Report');
  });
});

describe('ReportsService.cancel', () => {
  it('rejects cancelling a completed report', async () => {
    const { svc } = buildSvc();
    await expect(svc.cancel(TENANT, USER, 'rpt-1')).rejects.toBeInstanceOf(BusinessException);
  });

  it('marks pending → cancelled and audit-logs', async () => {
    const { svc, reportsRepo, audit } = buildSvc({
      reportsRepoStubs: {
        findByIdInTenant: jest.fn(async () => baseReport({ status: 'pending' })),
      },
    });
    await svc.cancel(TENANT, USER, 'rpt-1');
    const updateCall = (reportsRepo.update as jest.Mock).mock.calls[0]![1];
    expect(updateCall.status).toBe('cancelled');
    const auditCall = (audit.logAction as jest.Mock).mock.calls[0]![0];
    expect(auditCall.metadata.transition).toBe('cancel');
  });
});

describe('ReportsService.getDashboardSummary', () => {
  it('delegates to the generator and audit-logs a READ', async () => {
    const { svc, dashboard, audit } = buildSvc();
    const out = await svc.getDashboardSummary(TENANT, USER, 'store-1', validParams.dateRange);
    expect(dashboard.summarise as jest.Mock).toHaveBeenCalledWith(
      TENANT,
      'store-1',
      validParams.dateRange,
    );
    expect(out.storeId).toBe('store-1');
    const auditCall = (audit.logAction as jest.Mock).mock.calls[0]![0];
    expect(auditCall.action).toBe('READ');
    expect(auditCall.resourceType).toBe('DashboardSummary');
  });
});

describe('ReportsService.list', () => {
  it('returns projected report summaries', async () => {
    const { svc } = buildSvc();
    const out = await svc.list(TENANT, { limit: 50 });
    expect(out).toHaveLength(1);
    expect(out[0]!.reportId).toBe('rpt-1');
  });
});
