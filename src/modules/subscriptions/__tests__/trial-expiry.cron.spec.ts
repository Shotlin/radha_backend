import { TrialExpiryCron } from '@/jobs/cron/trial-expiry.cron';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { TrialService } from '@/modules/subscriptions/services/trial.service';

import type { TenantSubscription } from '../types/subscription.types';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const baseSub = (over: Partial<TenantSubscription> = {}): TenantSubscription =>
  ({
    id: 'sub-1',
    tenantId: 'tenant-1',
    planId: 'plan-trial',
    planCode: 'trial',
    status: 'trial',
    trialStartedAt: new Date(),
    trialEndsAt: new Date(),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(),
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
    createdBy: 'owner-user',
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as TenantSubscription;

describe('TrialExpiryCron', () => {
  it('sends a trial-expiring template per matched bucket and marks notified', async () => {
    const subs7 = [baseSub({ id: 'a' })];
    const subs3: TenantSubscription[] = [];
    const subs1 = [baseSub({ id: 'c', tenantId: 'tenant-c' })];

    const trial = {
      findExpiringIn: jest.fn(async (days: number) => {
        if (days === 7) return subs7;
        if (days === 3) return subs3;
        return subs1;
      }),
      expireTrials: jest.fn(async () => 2),
      markExpiringNotified: jest.fn(async () => undefined),
    } as unknown as TrialService;

    const notifications = {
      sendTemplate: jest.fn(async () => [] as unknown[]),
    } as unknown as NotificationsService;

    const cron = new TrialExpiryCron(trial, notifications, buildLogger());
    await cron.run();

    expect(notifications.sendTemplate as jest.Mock).toHaveBeenCalledTimes(2);
    expect((notifications.sendTemplate as jest.Mock).mock.calls[0][0]).toBe('trial-expiring');
    expect(trial.markExpiringNotified as jest.Mock).toHaveBeenCalledTimes(2);
    expect(trial.expireTrials as jest.Mock).toHaveBeenCalled();
  });

  it('runs the expireTrials sweep even when notification fan-out fails', async () => {
    const subs7 = [baseSub({ id: 'a' })];
    const trial = {
      findExpiringIn: jest.fn(async (days: number) => (days === 7 ? subs7 : [])),
      expireTrials: jest.fn(async () => 5),
      markExpiringNotified: jest.fn(async () => undefined),
    } as unknown as TrialService;
    const notifications = {
      sendTemplate: jest.fn(async () => {
        throw new Error('queue down');
      }),
    } as unknown as NotificationsService;
    const cron = new TrialExpiryCron(trial, notifications, buildLogger());
    await expect(cron.run()).resolves.toBeUndefined();
    expect(trial.expireTrials as jest.Mock).toHaveBeenCalled();
  });

  it('falls back to tenantId for the recipient when createdBy is null', async () => {
    const sub = baseSub({ createdBy: null, tenantId: 'tenant-fallback' });
    const trial = {
      findExpiringIn: jest.fn(async (days: number) => (days === 7 ? [sub] : [])),
      expireTrials: jest.fn(async () => 0),
      markExpiringNotified: jest.fn(async () => undefined),
    } as unknown as TrialService;
    const notifications = {
      sendTemplate: jest.fn(async () => [] as unknown[]),
    } as unknown as NotificationsService;
    const cron = new TrialExpiryCron(trial, notifications, buildLogger());
    await cron.run();
    const callArgs = (notifications.sendTemplate as jest.Mock).mock.calls[0];
    expect(callArgs[1]).toEqual([{ userId: 'tenant-fallback' }]);
    expect(callArgs[2]).toMatchObject({ daysRemaining: 7 });
  });
});
