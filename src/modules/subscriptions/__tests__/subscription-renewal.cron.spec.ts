import { SubscriptionRenewalCron } from '@/jobs/cron/subscription-renewal.cron';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { SubscriptionsRepository } from '@/modules/subscriptions/repositories/subscriptions.repository';
import { UpgradeService } from '@/modules/subscriptions/services/upgrade.service';

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
    planId: 'plan-starter',
    planCode: 'starter',
    status: 'active',
    trialStartedAt: null,
    trialEndsAt: null,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 2 * 86_400_000),
    cancelledAt: null,
    cancellationReason: null,
    monthlyAmount: '49',
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

describe('SubscriptionRenewalCron', () => {
  it('drives runRenewalsForDate and surfaces counts', async () => {
    const upgrade = {
      runRenewalsForDate: jest.fn(async () => ({ renewed: 3, applied: 1, expired: 2 })),
    } as unknown as UpgradeService;
    const subRepo = {
      findRenewalsDue: jest.fn(async () => []),
      update: jest.fn(),
    } as unknown as SubscriptionsRepository;
    const notifications = {
      sendTemplate: jest.fn(async () => [] as unknown[]),
    } as unknown as NotificationsService;
    const logger = buildLogger();

    const cron = new SubscriptionRenewalCron(upgrade, subRepo, notifications, logger);
    await cron.run();

    expect(upgrade.runRenewalsForDate as jest.Mock).toHaveBeenCalled();
    expect(logger.info as jest.Mock).toHaveBeenCalledWith(
      'cron.subscription-renewal.completed',
      expect.objectContaining({ renewed: 3, applied: 1, expired: 2 }),
    );
  });

  it('sends subscription-renewal reminders to upcoming subs and stamps the metadata flag', async () => {
    const upcoming = baseSub({ id: 'upcoming' });
    const upgrade = {
      runRenewalsForDate: jest.fn(async () => ({ renewed: 0, applied: 0, expired: 0 })),
    } as unknown as UpgradeService;
    const subRepo = {
      findRenewalsDue: jest.fn(async () => [upcoming]),
      update: jest.fn(async () => upcoming),
    } as unknown as SubscriptionsRepository;
    const notifications = {
      sendTemplate: jest.fn(async () => [] as unknown[]),
    } as unknown as NotificationsService;

    const cron = new SubscriptionRenewalCron(upgrade, subRepo, notifications, buildLogger());
    await cron.run();

    expect(notifications.sendTemplate as jest.Mock).toHaveBeenCalledWith(
      'subscription-renewal',
      [{ userId: 'owner-user' }],
      expect.objectContaining({ planName: 'starter' }),
      { tenantId: 'tenant-1' },
    );
    const updateCall = (subRepo.update as jest.Mock).mock.calls[0];
    expect(updateCall[1].metadata).toMatchObject({ renewalNotified: expect.any(String) });
  });

  it('skips subs that already carry the renewalNotified flag', async () => {
    const upcoming = baseSub({
      id: 'flagged',
      metadata: { renewalNotified: new Date().toISOString() },
    });
    const upgrade = {
      runRenewalsForDate: jest.fn(async () => ({ renewed: 0, applied: 0, expired: 0 })),
    } as unknown as UpgradeService;
    const subRepo = {
      findRenewalsDue: jest.fn(async () => [upcoming]),
      update: jest.fn(),
    } as unknown as SubscriptionsRepository;
    const notifications = {
      sendTemplate: jest.fn(),
    } as unknown as NotificationsService;
    const cron = new SubscriptionRenewalCron(upgrade, subRepo, notifications, buildLogger());
    await cron.run();
    expect(notifications.sendTemplate as jest.Mock).not.toHaveBeenCalled();
    expect(subRepo.update as jest.Mock).not.toHaveBeenCalled();
  });
});
