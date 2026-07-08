import { ValidationException } from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';

import { AuditTrailGenerator } from '../generators/audit-trail.generator';
import { DashboardSummaryGenerator } from '../generators/dashboard-summary.generator';
import { EanMismatchGenerator } from '../generators/ean-mismatch.generator';
import { ExpirySummaryGenerator } from '../generators/expiry-summary.generator';
import { GrnHistoryGenerator } from '../generators/grn-history.generator';
import { HealthDistributionGenerator } from '../generators/health-distribution.generator';
import { InventorySummaryGenerator } from '../generators/inventory-summary.generator';
import { ScanHistoryGenerator } from '../generators/scan-history.generator';
import { TaskCompletionGenerator } from '../generators/task-completion.generator';
import { ReportGeneratorService } from '../services/report-generator.service';
import type {
  GenerateReportParams,
  IReportGenerator,
  ReportData,
  ReportType,
} from '../types/report.types';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const stubGenerator = (
  type: ReportType,
  result: ReportData = {
    summary: {},
    rows: [],
    generatedAt: new Date(),
  },
): IReportGenerator => ({
  type,
  generate: jest.fn(async () => result),
});

const makeService = (overrides: Partial<Record<ReportType, IReportGenerator>> = {}) => {
  const expiry = (overrides['expiry-summary'] ??
    stubGenerator('expiry-summary')) as ExpirySummaryGenerator;
  const eanMismatch = (overrides['ean-mismatch'] ??
    stubGenerator('ean-mismatch')) as EanMismatchGenerator;
  const scanHistory = (overrides['scan-history'] ??
    stubGenerator('scan-history')) as ScanHistoryGenerator;
  const taskCompletion = (overrides['task-completion'] ??
    stubGenerator('task-completion')) as TaskCompletionGenerator;
  const dashboard = (overrides['dashboard'] ??
    stubGenerator('dashboard')) as DashboardSummaryGenerator;
  const auditTrail = (overrides['audit-trail'] ??
    stubGenerator('audit-trail')) as AuditTrailGenerator;
  const healthDistribution = (overrides['health-distribution'] ??
    stubGenerator('health-distribution')) as HealthDistributionGenerator;
  const inventory = (overrides['inventory-summary'] ??
    stubGenerator('inventory-summary')) as InventorySummaryGenerator;
  const grnHistory = (overrides['grn-history'] ??
    stubGenerator('grn-history')) as GrnHistoryGenerator;

  return new ReportGeneratorService(
    buildLogger(),
    expiry,
    eanMismatch,
    scanHistory,
    taskCompletion,
    dashboard,
    auditTrail,
    healthDistribution,
    inventory,
    grnHistory,
  );
};

const params: GenerateReportParams = {
  type: 'expiry-summary',
  formats: ['xlsx'],
  dateRange: {
    from: new Date('2026-04-01T00:00:00Z'),
    to: new Date('2026-04-30T00:00:00Z'),
  },
};

describe('ReportGeneratorService', () => {
  it('reports the full set of supported types', () => {
    const svc = makeService();
    expect(svc.supportedTypes().sort()).toEqual([
      'audit-trail',
      'dashboard',
      'ean-mismatch',
      'expiry-summary',
      'grn-history',
      'health-distribution',
      'inventory-summary',
      'scan-history',
      'task-completion',
    ]);
  });

  it('answers `has(type)` correctly', () => {
    const svc = makeService();
    expect(svc.has('expiry-summary')).toBe(true);
    expect(svc.has('unknown' as ReportType)).toBe(false);
  });

  it('dispatches to the matching generator', async () => {
    const expiry = stubGenerator('expiry-summary', {
      summary: { total: 1 },
      rows: [{ id: '1' }],
      generatedAt: new Date(),
    });
    const svc = makeService({ 'expiry-summary': expiry });
    const out = await svc.run('expiry-summary', params, 'tenant-A');
    expect(out.summary).toEqual({ total: 1 });
    expect(expiry.generate).toHaveBeenCalledWith(params, 'tenant-A');
  });

  it('throws ValidationException for an unknown type', async () => {
    const svc = makeService();
    await expect(svc.run('mystery' as ReportType, params, 'tenant-A')).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('rethrows generator errors', async () => {
    const failing = stubGenerator('expiry-summary');
    (failing.generate as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    const svc = makeService({ 'expiry-summary': failing });
    await expect(svc.run('expiry-summary', params, 'tenant-A')).rejects.toThrow('boom');
  });
});
