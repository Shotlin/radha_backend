import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import type { ExpiryAlertRow, ExpiryRecordRow } from '@/db/schema/expiry';
import { LoggerService } from '@/logging/logger.service';

import { ExpiryAlertsRepository } from '../repositories/expiry-alerts.repository';
import { ExpiryAlertService } from '../services/expiry-alert.service';

const TENANT = 'tenant-1';
const USER = 'user-1';

const baseRecord = (over: Partial<ExpiryRecordRow> = {}): ExpiryRecordRow =>
  ({
    id: 'rec-1',
    tenantId: TENANT,
    storeId: 'store-1',
    productId: 'prod-1',
    status: 'red',
    daysRemaining: 3,
    quantity: 10,
    remainingQuantity: 10,
    ...over,
  }) as unknown as ExpiryRecordRow;

const baseAlert = (over: Partial<ExpiryAlertRow> = {}): ExpiryAlertRow =>
  ({
    id: 'alert-1',
    tenantId: TENANT,
    storeId: 'store-1',
    expiryRecordId: 'rec-1',
    productId: 'prod-1',
    status: 'red',
    daysRemaining: 3,
    quantity: 10,
    isAcknowledged: false,
    isResolved: false,
    ...over,
  }) as unknown as ExpiryAlertRow;

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildSvc = (
  overrides: {
    byRecord?: ExpiryAlertRow | null;
    byId?: ExpiryAlertRow | null;
    insertReturns?: ExpiryAlertRow | null;
  } = {},
) => {
  const repo = {
    findActiveByRecord: jest.fn(async () => overrides.byRecord ?? null),
    findByIdInTenant: jest.fn(async () => overrides.byId ?? null),
    insertIfMissing: jest.fn(async () => overrides.insertReturns ?? null),
    update: jest.fn(
      async (id: string, data: Partial<ExpiryAlertRow>) =>
        ({ ...(overrides.byId ?? baseAlert()), ...data, id }) as ExpiryAlertRow,
    ),
  } as unknown as ExpiryAlertsRepository;
  const svc = new ExpiryAlertService(repo, buildLogger());
  return { svc, repo };
};

describe('ExpiryAlertService.ensureForRecord', () => {
  it('returns the existing active alert without inserting', async () => {
    const existing = baseAlert();
    const { svc, repo } = buildSvc({ byRecord: existing });
    const out = await svc.ensureForRecord(baseRecord(), 'red');
    expect(out).toBe(existing);
    expect(repo.insertIfMissing as jest.Mock).not.toHaveBeenCalled();
  });

  it('inserts when no active alert exists', async () => {
    const fresh = baseAlert({ id: 'alert-2' });
    const { svc, repo } = buildSvc({ insertReturns: fresh });
    const out = await svc.ensureForRecord(baseRecord(), 'red');
    expect(out.id).toBe('alert-2');
    expect(repo.insertIfMissing as jest.Mock).toHaveBeenCalled();
  });

  it('falls back to a re-read on conflict (race)', async () => {
    const winner = baseAlert({ id: 'alert-3' });
    const repo = {
      findActiveByRecord: jest
        .fn()
        .mockResolvedValueOnce(null) // first call inside ensureForRecord
        .mockResolvedValueOnce(winner), // re-read after onConflictDoNothing
      findByIdInTenant: jest.fn(),
      insertIfMissing: jest.fn(async () => null),
      update: jest.fn(),
    } as unknown as ExpiryAlertsRepository;
    const svc = new ExpiryAlertService(repo, buildLogger());
    const out = await svc.ensureForRecord(baseRecord(), 'red');
    expect(out.id).toBe('alert-3');
  });

  it('throws BusinessException when re-read also fails', async () => {
    const repo = {
      findActiveByRecord: jest.fn().mockResolvedValue(null),
      findByIdInTenant: jest.fn(),
      insertIfMissing: jest.fn(async () => null),
      update: jest.fn(),
    } as unknown as ExpiryAlertsRepository;
    const svc = new ExpiryAlertService(repo, buildLogger());
    await expect(svc.ensureForRecord(baseRecord(), 'red')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });
});

describe('ExpiryAlertService.acknowledge', () => {
  it('throws when alert missing', async () => {
    const { svc } = buildSvc({ byId: null });
    await expect(svc.acknowledge(TENANT, USER, 'a-1')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects when alert already resolved', async () => {
    const { svc } = buildSvc({ byId: baseAlert({ isResolved: true }) });
    await expect(svc.acknowledge(TENANT, USER, 'a-1')).rejects.toBeInstanceOf(BusinessException);
  });

  it('marks alert acknowledged with notes', async () => {
    const { svc, repo } = buildSvc({ byId: baseAlert() });
    await svc.acknowledge(TENANT, USER, 'a-1', 'Will discount tomorrow');
    const updateCall = (repo.update as jest.Mock).mock.calls[0]![1];
    expect(updateCall.isAcknowledged).toBe(true);
    expect(updateCall.acknowledgedBy).toBe(USER);
    expect(updateCall.acknowledgedNotes).toBe('Will discount tomorrow');
  });
});

describe('ExpiryAlertService.resolve', () => {
  it('returns existing alert when already resolved (idempotent)', async () => {
    const resolved = baseAlert({ isResolved: true, resolvedBy: 'u-9' });
    const { svc, repo } = buildSvc({ byId: resolved });
    const out = await svc.resolve(TENANT, USER, 'a-1', 'discounted');
    expect(out).toBe(resolved);
    expect(repo.update as jest.Mock).not.toHaveBeenCalled();
  });

  it('marks alert resolved with the supplied resolution', async () => {
    const { svc, repo } = buildSvc({ byId: baseAlert() });
    await svc.resolve(TENANT, USER, 'a-1', 'returned', 'sent back to vendor');
    const updateCall = (repo.update as jest.Mock).mock.calls[0]![1];
    expect(updateCall.isResolved).toBe(true);
    expect(updateCall.resolution).toBe('returned');
    expect(updateCall.acknowledgedNotes).toBe('sent back to vendor');
  });
});
