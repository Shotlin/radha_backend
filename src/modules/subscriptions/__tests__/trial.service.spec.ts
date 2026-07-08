import {
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { PlansRepository } from '../repositories/plans.repository';
import { SubscriptionEventsRepository } from '../repositories/subscription-events.repository';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { TrialService } from '../services/trial.service';
import type { TenantSubscription } from '../types/subscription.types';

const TENANT = '00000000-0000-0000-0000-000000000001';
const PLAN_ID = '00000000-0000-0000-0000-000000000002';
const SUB_ID = '00000000-0000-0000-0000-000000000003';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const trialPlan = {
  id: PLAN_ID,
  code: 'trial',
  name: 'Free Trial',
  description: '90 days',
  price: '0',
  yearlyPrice: null,
  currency: 'INR',
  trialDays: 90,
  isPublic: false,
  isActive: true,
  sortOrder: 0,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const baseSub = (over: Partial<TenantSubscription> = {}): TenantSubscription =>
  ({
    id: SUB_ID,
    tenantId: TENANT,
    planId: PLAN_ID,
    planCode: 'trial',
    status: 'trial',
    trialStartedAt: new Date(),
    trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelledAt: null,
    cancellationReason: null,
    monthlyAmount: '0',
    nextBillingDate: null,
    paymentMethod: null,
    lastPaymentAt: null,
    failedPaymentAttempts: 0,
    pendingPlanId: null,
    pendingPlanCode: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as TenantSubscription;

interface BuildOpts {
  existing?: TenantSubscription | null;
  trialPlanFound?: boolean;
  expiringTrials?: TenantSubscription[];
  guardReturnsNull?: boolean;
  expiringIn?: TenantSubscription[];
}

const buildSvc = (opts: BuildOpts = {}) => {
  const subRepo = {
    findByTenant: jest.fn(async () => opts.existing ?? null),
    create: jest.fn(async (data: Partial<TenantSubscription>) => baseSub({ ...data, id: SUB_ID })),
    findExpiringTrials: jest.fn(async () => opts.expiringTrials ?? []),
    findTrialsExpiringIn: jest.fn(async () => opts.expiringIn ?? []),
    updateStatusGuarded: jest.fn(
      async (_id: string, _from: unknown, patch: Partial<TenantSubscription>) =>
        opts.guardReturnsNull ? null : baseSub({ ...patch, id: SUB_ID }),
    ),
    findById: jest.fn(async () => opts.existing ?? null),
    update: jest.fn(async (id: string, patch: Partial<TenantSubscription>) =>
      baseSub({ ...patch, id }),
    ),
  } as unknown as SubscriptionsRepository;

  const plansRepo = {
    findByCode: jest.fn(async (code: string) =>
      opts.trialPlanFound !== false && code === 'trial' ? trialPlan : null,
    ),
  } as unknown as PlansRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as SubscriptionEventsRepository;

  const auditLog = {
    logAction: jest.fn(async () => undefined),
  } as unknown as AuditLogService;

  const svc = new TrialService(subRepo, plansRepo, eventsRepo, auditLog, buildLogger());
  return { svc, subRepo, plansRepo, eventsRepo, auditLog };
};

describe('TrialService.startTrial', () => {
  it('creates a trial subscription with the configured trialDays', async () => {
    const { svc, subRepo, eventsRepo, auditLog } = buildSvc();
    const sub = await svc.startTrial(TENANT);
    expect(sub.planCode).toBe('trial');
    expect(sub.status).toBe('trial');
    expect((subRepo.create as jest.Mock).mock.calls[0][0].planCode).toBe('trial');
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('trial_started');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0]).toMatchObject({
      action: 'CREATE',
      resourceType: 'TenantSubscription',
      metadata: { transition: 'trial_started', trialDays: 90 },
    });
  });

  it('rejects with DUPLICATE_RESOURCE when a subscription already exists', async () => {
    const { svc } = buildSvc({ existing: baseSub() });
    await expect(svc.startTrial(TENANT)).rejects.toBeInstanceOf(DomainConflictException);
  });

  it('throws when the trial plan is not seeded', async () => {
    const { svc } = buildSvc({ trialPlanFound: false });
    await expect(svc.startTrial(TENANT)).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('sets currentPeriodEnd equal to trial_ends_at', async () => {
    const { svc, subRepo } = buildSvc();
    await svc.startTrial(TENANT);
    const arg = (subRepo.create as jest.Mock).mock.calls[0][0];
    expect(arg.currentPeriodEnd.getTime()).toBe(arg.trialEndsAt.getTime());
  });
});

describe('TrialService.getDaysRemaining', () => {
  it('returns 0 when there is no subscription', async () => {
    const { svc } = buildSvc({ existing: null });
    expect(await svc.getDaysRemaining(TENANT)).toBe(0);
  });

  it('returns 0 when subscription is not in trial', async () => {
    const { svc } = buildSvc({ existing: baseSub({ status: 'active' }) });
    expect(await svc.getDaysRemaining(TENANT)).toBe(0);
  });

  it('returns the ceiling of remaining days for an active trial', async () => {
    const trialEndsAt = new Date(Date.now() + 5 * 86_400_000 + 60_000);
    const { svc } = buildSvc({ existing: baseSub({ status: 'trial', trialEndsAt }) });
    const days = await svc.getDaysRemaining(TENANT);
    expect(days).toBeGreaterThanOrEqual(5);
    expect(days).toBeLessThanOrEqual(6);
  });
});

describe('TrialService.expireTrials', () => {
  it('flips elapsed trials to expired and emits event + audit log', async () => {
    const elapsed = baseSub({
      id: 'sub-elapsed',
      trialEndsAt: new Date(Date.now() - 1000),
      status: 'trial',
    });
    const { svc, eventsRepo, auditLog, subRepo } = buildSvc({ expiringTrials: [elapsed] });
    const count = await svc.expireTrials();
    expect(count).toBe(1);
    const guardCall = (subRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(guardCall[0]).toBe('sub-elapsed');
    expect(guardCall[1]).toEqual(['trial']);
    expect(guardCall[2]).toMatchObject({ status: 'expired' });
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('trial_expired');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0].metadata.transition).toBe(
      'trial_expired',
    );
  });

  it('skips rows whose state changed concurrently (guard returns null)', async () => {
    const elapsed = baseSub({ id: 'sub-elapsed' });
    const { svc, eventsRepo } = buildSvc({
      expiringTrials: [elapsed],
      guardReturnsNull: true,
    });
    const count = await svc.expireTrials();
    expect(count).toBe(0);
    expect(eventsRepo.create as jest.Mock).not.toHaveBeenCalled();
  });

  it('returns 0 when no trials are elapsed', async () => {
    const { svc } = buildSvc({ expiringTrials: [] });
    expect(await svc.expireTrials()).toBe(0);
  });
});

describe('TrialService.markExpiringNotified', () => {
  it('stamps the metadata key and emits a trial_expiring_soon event', async () => {
    const sub = baseSub({ metadata: {} });
    const { svc, subRepo, eventsRepo } = buildSvc({ existing: sub });
    await svc.markExpiringNotified(sub.id, sub.tenantId, 7);
    const updateCall = (subRepo.update as jest.Mock).mock.calls[0][1];
    expect(updateCall.metadata).toMatchObject({
      trialExpiryNotified7d: expect.any(String),
    });
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('trial_expiring_soon');
  });

  it('skips a second mark within the same days bucket', async () => {
    const sub = baseSub({
      metadata: { trialExpiryNotified7d: new Date().toISOString() },
    });
    const { svc, subRepo, eventsRepo } = buildSvc({ existing: sub });
    await svc.markExpiringNotified(sub.id, sub.tenantId, 7);
    expect(subRepo.update as jest.Mock).not.toHaveBeenCalled();
    expect(eventsRepo.create as jest.Mock).not.toHaveBeenCalled();
  });
});
