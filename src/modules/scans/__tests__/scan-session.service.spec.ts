import {
  BusinessException,
  DomainConflictException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import type { ScanSessionRow } from '@/db/schema/scans';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { ScanSessionsRepository } from '../repositories/scan-sessions.repository';
import { ScanSessionService } from '../services/scan-session.service';
import { ScanSummaryService } from '../services/scan-summary.service';

const TENANT = 'tenant-1';
const STORE = 'store-1';
const USER = 'user-1';

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

const dbThatRunsCallback = (): DbService =>
  ({
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  }) as unknown as DbService;

const baseSession = (over: Partial<ScanSessionRow> = {}): ScanSessionRow =>
  ({
    id: 'session-1',
    tenantId: TENANT,
    storeId: STORE,
    userId: USER,
    status: 'active',
    type: 'audit',
    totalScans: 0,
    uniqueProducts: 0,
    matchedEans: 0,
    unmatchedEans: 0,
    expiredItems: 0,
    nearExpiryItems: 0,
    startedAt: new Date('2026-05-01T10:00:00Z'),
    metadata: {},
    deletedAt: null,
    ...over,
  }) as unknown as ScanSessionRow;

const buildSvc = (
  opts: {
    active?: ScanSessionRow | null;
    session?: ScanSessionRow | null;
    aggregate?: Awaited<ReturnType<ScanItemsRepository['aggregateForSession']>>;
  } = {},
) => {
  const sessionsRepo = {
    findActiveForUser: jest.fn(async () => opts.active ?? null),
    findByIdInTenant: jest.fn(async () => opts.session ?? null),
    create: jest.fn(async (data: Partial<ScanSessionRow>) =>
      baseSession({ ...data, id: 'created-id' }),
    ),
    update: jest.fn(async (id: string, data: Partial<ScanSessionRow>) =>
      baseSession({ ...(opts.session ?? {}), ...data, id }),
    ),
    findStaleActive: jest.fn(async () => []),
    listForTenant: jest.fn(async () => []),
    getDailyStats: jest.fn(async () => ({
      date: '2026-05-01',
      totalSessions: 0,
      totalScans: 0,
      byType: {},
    })),
  } as unknown as ScanSessionsRepository;

  const itemsRepo = {
    aggregateForSession: jest.fn(
      async () =>
        opts.aggregate ?? {
          totalScans: 0,
          uniqueProducts: 0,
          matchedEans: 0,
          unmatchedEans: 0,
          expiredItems: 0,
          nearExpiryItems: 0,
        },
    ),
  } as unknown as ScanItemsRepository;

  const summary = {
    forSession: jest.fn(async () => ({
      sessionId: 'session-1',
      totalScans: 0,
      uniqueProducts: 0,
      matchedEans: 0,
      unmatchedEans: 0,
      expiredItems: 0,
      nearExpiryItems: 0,
      warningsCount: 0,
      durationSeconds: 0,
      scanRate: 0,
    })),
  } as unknown as ScanSummaryService;

  const svc = new ScanSessionService(
    dbThatRunsCallback(),
    sessionsRepo,
    itemsRepo,
    summary,
    buildAudit(),
    buildLogger(),
  );
  return { svc, sessionsRepo, itemsRepo };
};

describe('ScanSessionService.create', () => {
  it('rejects when an active session already exists', async () => {
    const { svc } = buildSvc({ active: baseSession() });
    await expect(
      svc.create(TENANT, USER, { storeId: STORE, type: 'audit' }),
    ).rejects.toBeInstanceOf(DomainConflictException);
  });

  it('creates a new session when none active', async () => {
    const { svc, sessionsRepo } = buildSvc();
    const out = await svc.create(TENANT, USER, { storeId: STORE, type: 'audit' });
    expect(out.id).toBe('created-id');
    expect((sessionsRepo.create as jest.Mock).mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      storeId: STORE,
      userId: USER,
      type: 'audit',
      status: 'active',
    });
  });
});

describe('ScanSessionService.end', () => {
  it('throws DomainNotFoundException for missing session', async () => {
    const { svc } = buildSvc({ session: null });
    await expect(svc.end(TENANT, USER, 'session-1', {})).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('throws DomainForbiddenException when caller is not the owner', async () => {
    const { svc } = buildSvc({ session: baseSession({ userId: 'other-user' }) });
    await expect(svc.end(TENANT, USER, 'session-1', {})).rejects.toBeInstanceOf(
      DomainForbiddenException,
    );
  });

  it('throws BusinessException when session already closed', async () => {
    const { svc } = buildSvc({ session: baseSession({ status: 'completed' }) });
    await expect(svc.end(TENANT, USER, 'session-1', {})).rejects.toBeInstanceOf(BusinessException);
  });

  it('updates status to completed and refreshes counters from items aggregate', async () => {
    const { svc, sessionsRepo } = buildSvc({
      session: baseSession(),
      aggregate: {
        totalScans: 7,
        uniqueProducts: 5,
        matchedEans: 4,
        unmatchedEans: 2,
        expiredItems: 1,
        nearExpiryItems: 1,
      },
    });
    const updated = await svc.end(TENANT, USER, 'session-1', { notes: 'done' });
    expect(updated.status).toBe('completed');
    const updatePayload = (sessionsRepo.update as jest.Mock).mock.calls[0][1];
    expect(updatePayload).toMatchObject({
      status: 'completed',
      totalScans: 7,
      matchedEans: 4,
    });
    expect(updatePayload.metadata).toMatchObject({ endNotes: 'done' });
  });
});

describe('ScanSessionService.abandon', () => {
  it('returns the session unchanged when not active', async () => {
    const session = baseSession({ status: 'completed' });
    const { svc, sessionsRepo } = buildSvc({ session });
    const out = await svc.abandon(TENANT, USER, 'session-1');
    expect(out).toBe(session);
    expect(sessionsRepo.update as jest.Mock).not.toHaveBeenCalled();
  });

  it('flips active → abandoned', async () => {
    const { svc, sessionsRepo } = buildSvc({ session: baseSession() });
    await svc.abandon(TENANT, USER, 'session-1');
    const payload = (sessionsRepo.update as jest.Mock).mock.calls[0][1];
    expect(payload.status).toBe('abandoned');
    expect(payload.endedAt).toBeInstanceOf(Date);
  });
});

describe('ScanSessionService.expireStaleSessions', () => {
  it('returns 0 when no stale sessions', async () => {
    const { svc } = buildSvc();
    expect(await svc.expireStaleSessions(new Date())).toBe(0);
  });
});
