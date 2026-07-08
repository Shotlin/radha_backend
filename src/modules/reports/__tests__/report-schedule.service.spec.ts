import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ReportSchedulesRepository } from '../repositories/report-schedules.repository';
import { ReportScheduleService } from '../services/report-schedule.service';
import type { ScheduleReportParams } from '../types/report.types';

const TENANT = 'tenant-1';
const USER = 'user-1';

type ScheduleRow = {
  id: string;
  tenantId: string;
  storeId: string | null;
  type: string;
  title: string;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hourOfDay: number;
  status: string;
  parameters: Record<string, unknown>;
  recipients: string[];
  nextRunAt: Date;
  [key: string]: unknown;
};

const baseSchedule = (over: Record<string, unknown> = {}): ScheduleRow =>
  ({
    id: 'sched-1',
    tenantId: TENANT,
    storeId: null,
    type: 'expiry-summary',
    title: 'Weekly expiry',
    frequency: 'weekly',
    dayOfWeek: 1,
    dayOfMonth: null,
    hourOfDay: 9,
    status: 'active',
    parameters: {},
    recipients: [],
    nextRunAt: new Date('2026-04-13T09:00:00Z'),
    ...over,
  }) as ScheduleRow;

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

const buildRepo = (
  overrides: {
    byId?: ScheduleRow | null;
  } = {},
) => {
  const created = baseSchedule({ id: 'sched-2' });
  return {
    findByIdInTenant: jest.fn(async () => overrides.byId ?? null),
    listForTenant: jest.fn(async () => [baseSchedule()]),
    create: jest.fn(async () => created),
    update: jest.fn(async (_id: string, data: Record<string, unknown>) => ({
      ...(overrides.byId ?? created),
      ...data,
    })),
  } as unknown as ReportSchedulesRepository;
};

const params: ScheduleReportParams = {
  type: 'expiry-summary',
  title: 'Weekly expiry',
  frequency: 'weekly',
  dayOfWeek: 1,
  hourOfDay: 9,
  parameters: {
    type: 'expiry-summary',
    formats: ['xlsx'],
    dateRange: {
      from: new Date('2026-04-01T00:00:00Z'),
      to: new Date('2026-04-30T00:00:00Z'),
    },
  },
};

describe('ReportScheduleService', () => {
  describe('create', () => {
    it('persists the schedule with a computed nextRunAt and audit-logs', async () => {
      const repo = buildRepo();
      const audit = buildAudit();
      const svc = new ReportScheduleService(repo, buildLogger(), audit);
      const out = await svc.create(TENANT, USER, params);
      expect(out).toBeDefined();
      const createCall = (repo.create as jest.Mock).mock.calls[0]![0];
      expect(createCall.frequency).toBe('weekly');
      expect(createCall.nextRunAt).toBeInstanceOf(Date);
      expect(createCall.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(audit.logAction as jest.Mock).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel', () => {
    it('throws DomainNotFoundException when schedule missing', async () => {
      const repo = buildRepo({ byId: null });
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      await expect(svc.cancel(TENANT, USER, 'missing')).rejects.toBeInstanceOf(
        DomainNotFoundException,
      );
    });

    it('returns the existing row when already cancelled (idempotent)', async () => {
      const cancelled = baseSchedule({ status: 'cancelled' });
      const repo = buildRepo({ byId: cancelled });
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      const out = await svc.cancel(TENANT, USER, 'sched-1');
      expect(out).toBe(cancelled);
      expect(repo.update as jest.Mock).not.toHaveBeenCalled();
    });

    it('clears nextRunAt and audit-logs the transition', async () => {
      const repo = buildRepo({ byId: baseSchedule() });
      const audit = buildAudit();
      const svc = new ReportScheduleService(repo, buildLogger(), audit);
      await svc.cancel(TENANT, USER, 'sched-1');
      const updateCall = (repo.update as jest.Mock).mock.calls[0]![1];
      expect(updateCall.status).toBe('cancelled');
      expect(updateCall.nextRunAt).toBeNull();
      const auditCall = (audit.logAction as jest.Mock).mock.calls[0]![0];
      expect(auditCall.metadata.transition).toBe('cancel');
    });
  });

  describe('pause / resume', () => {
    it('rejects pausing a cancelled schedule', async () => {
      const repo = buildRepo({ byId: baseSchedule({ status: 'cancelled' }) });
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      await expect(svc.pause(TENANT, USER, 'sched-1')).rejects.toBeInstanceOf(BusinessException);
    });

    it('rejects resuming a cancelled schedule', async () => {
      const repo = buildRepo({ byId: baseSchedule({ status: 'cancelled' }) });
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      await expect(svc.resume(TENANT, USER, 'sched-1')).rejects.toBeInstanceOf(BusinessException);
    });

    it('pauses an active schedule', async () => {
      const repo = buildRepo({ byId: baseSchedule() });
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      await svc.pause(TENANT, USER, 'sched-1');
      const updateCall = (repo.update as jest.Mock).mock.calls[0]![1];
      expect(updateCall.status).toBe('paused');
    });

    it('resumes a paused schedule and recomputes nextRunAt', async () => {
      const repo = buildRepo({ byId: baseSchedule({ status: 'paused' }) });
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      await svc.resume(TENANT, USER, 'sched-1');
      const updateCall = (repo.update as jest.Mock).mock.calls[0]![1];
      expect(updateCall.status).toBe('active');
      expect(updateCall.nextRunAt).toBeInstanceOf(Date);
    });
  });

  describe('list / findById', () => {
    it('returns repository rows for a tenant', async () => {
      const repo = buildRepo();
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      const list = await svc.list(TENANT);
      expect(list).toHaveLength(1);
    });

    it('throws DomainNotFoundException for missing schedule', async () => {
      const repo = buildRepo({ byId: null });
      const svc = new ReportScheduleService(repo, buildLogger(), buildAudit());
      await expect(svc.findById(TENANT, 'missing')).rejects.toBeInstanceOf(DomainNotFoundException);
    });
  });
});
