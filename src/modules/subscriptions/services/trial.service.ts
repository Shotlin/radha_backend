import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { PlansRepository } from '../repositories/plans.repository';
import { SubscriptionEventsRepository } from '../repositories/subscription-events.repository';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import type { TenantSubscription } from '../types/subscription.types';

const SUBSCRIPTION_RESOURCE = 'TenantSubscription';

/**
 * BE-28 — Trial lifecycle service.
 *
 * Owns:
 *   - `startTrial`         : creates the initial trial subscription
 *                            on tenant onboarding.
 *   - `getDaysRemaining`   : convenience for the dashboard banner.
 *   - `expireTrials`       : flips elapsed trials to `expired`.
 *   - `findExpiringIn`     : surfaces upcoming-expiry trials for the
 *                            7/3/1-day reminder cron.
 *
 * `expireTrials` runs inside a single sweep — each row update is its
 * own audit log + event row, so a partial failure leaves the rest in
 * a clean state. Errors are logged and counted but never re-thrown
 * (so the cron stays green).
 */
@Injectable()
export class TrialService {
  constructor(
    private readonly subRepo: SubscriptionsRepository,
    private readonly plansRepo: PlansRepository,
    private readonly eventsRepo: SubscriptionEventsRepository,
    private readonly auditLog: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  async startTrial(tenantId: string): Promise<TenantSubscription> {
    const existing = await this.subRepo.findByTenant(tenantId);
    if (existing) {
      throw new DomainConflictException(
        `Subscription already exists for tenant ${tenantId}`,
        ErrorCode.DUPLICATE_RESOURCE,
        { metadata: { tenantId, existingSubscriptionId: existing.id } },
      );
    }

    const trialPlan = await this.plansRepo.findByCode('trial');
    if (!trialPlan) {
      throw new DomainNotFoundException('SubscriptionPlan', 'trial');
    }

    const now = new Date();
    const trialEndsAt = new Date(now);
    trialEndsAt.setDate(trialEndsAt.getDate() + trialPlan.trialDays);

    const subscription = await this.subRepo.create({
      tenantId,
      planId: trialPlan.id,
      planCode: 'trial',
      status: 'trial',
      trialStartedAt: now,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      monthlyAmount: '0',
      metadata: {},
    });

    await this.eventsRepo.create({
      tenantId,
      subscriptionId: subscription.id,
      type: 'trial_started',
      newPlanCode: 'trial',
      notes: `Trial started for ${trialPlan.trialDays} days`,
      metadata: { trialDays: trialPlan.trialDays, trialEndsAt: trialEndsAt.toISOString() },
    });

    await this.auditLog.logAction({
      action: 'CREATE',
      resourceType: SUBSCRIPTION_RESOURCE,
      resourceId: subscription.id,
      tenantId,
      userId: 'system',
      success: true,
      metadata: {
        transition: 'trial_started',
        trialDays: trialPlan.trialDays,
        trialEndsAt: trialEndsAt.toISOString(),
      },
    });

    this.logger.info('subscription.trial.started', {
      tenantId,
      subscriptionId: subscription.id,
      trialDays: trialPlan.trialDays,
    });

    return subscription;
  }

  async getDaysRemaining(tenantId: string): Promise<number> {
    const subscription = await this.subRepo.findByTenant(tenantId);
    if (!subscription || subscription.status !== 'trial' || !subscription.trialEndsAt) return 0;
    const diffMs = subscription.trialEndsAt.getTime() - Date.now();
    return Math.max(0, Math.ceil(diffMs / 86_400_000));
  }

  /**
   * Expire trials whose `trial_ends_at` has elapsed.
   * Returns the number of subscriptions transitioned.
   */
  async expireTrials(now: Date = new Date()): Promise<number> {
    const expiring = await this.subRepo.findExpiringTrials(now);
    let expired = 0;
    for (const sub of expiring) {
      try {
        const updated = await this.subRepo.updateStatusGuarded(sub.id, ['trial'], {
          status: 'expired',
          currentPeriodEnd: now,
        });
        if (!updated) continue;
        await this.eventsRepo.create({
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          type: 'trial_expired',
          oldPlanCode: sub.planCode,
          notes: 'Trial period elapsed',
        });
        await this.auditLog.logAction({
          action: 'UPDATE',
          resourceType: SUBSCRIPTION_RESOURCE,
          resourceId: sub.id,
          tenantId: sub.tenantId,
          userId: 'system',
          success: true,
          metadata: { transition: 'trial_expired' },
        });
        expired += 1;
      } catch (err) {
        this.logger.error('subscription.trial.expire.failed', {
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return expired;
  }

  /**
   * Helper for the cron — finds trials that fall in the
   * `[now + days - 1, now + days)` bucket so the 7/3/1-day reminders
   * fire exactly once per bucket.
   */
  async findExpiringIn(days: number, now: Date = new Date()): Promise<TenantSubscription[]> {
    return this.subRepo.findTrialsExpiringIn(days, now);
  }

  /**
   * Records that a "trial expiring soon" notification has been
   * queued for a given (subscription, days) bucket. The cron skips
   * rows that already carry a marker for the same `days` value.
   */
  async markExpiringNotified(
    subscriptionId: string,
    tenantId: string,
    days: number,
  ): Promise<void> {
    const sub = await this.subRepo.findById(subscriptionId);
    if (!sub) return;
    const existing =
      typeof sub.metadata === 'object' && sub.metadata !== null
        ? (sub.metadata as Record<string, unknown>)
        : {};
    const notifiedKey = `trialExpiryNotified${days}d`;
    if (existing[notifiedKey]) return;
    await this.subRepo.update(subscriptionId, {
      metadata: { ...existing, [notifiedKey]: new Date().toISOString() },
    });
    await this.eventsRepo.create({
      tenantId,
      subscriptionId,
      type: 'trial_expiring_soon',
      notes: `Notification sent — ${days} day(s) remaining`,
      metadata: { days },
    });
  }

  /**
   * Throws when the tenant doesn't already have a subscription
   * record. Used by the upgrade service to enforce that "you can
   * only upgrade from an existing subscription" rule.
   */
  async ensureSubscriptionExists(tenantId: string): Promise<TenantSubscription> {
    const sub = await this.subRepo.findByTenant(tenantId);
    if (!sub) {
      throw new BusinessException(
        ErrorCode.SUBSCRIPTION_REQUIRED,
        'No subscription found for this tenant',
        { metadata: { tenantId } },
      );
    }
    return sub;
  }
}
