import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { PLAN_ORDER } from '../constants/default-plans';
import { PlansRepository } from '../repositories/plans.repository';
import { SubscriptionEventsRepository } from '../repositories/subscription-events.repository';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import type { PlanCode, TenantSubscription } from '../types/subscription.types';

const SUBSCRIPTION_RESOURCE = 'TenantSubscription';
const SYSTEM_ACTOR = 'system';

/**
 * BE-28 — Plan upgrade / downgrade / cancel / reactivate.
 *
 * Lifecycle rules:
 *   - Upgrade: new limits applied immediately, billing period
 *     reset to a 30-day window from now.
 *   - Downgrade: scheduled for end of billing cycle (spec test 8).
 *     `pendingPlanId` + `pendingPlanCode` are stamped; the renewal
 *     cron applies them at `currentPeriodEnd`.
 *   - Cancel: stamps `cancelledAt`, status flips to `cancelled` but
 *     access stays granted until `currentPeriodEnd`. The cron flips
 *     to `expired` at that point.
 *   - Reactivate: clears cancel stamps; only valid for `cancelled`
 *     subscriptions whose period hasn't yet elapsed.
 *
 * Every transition emits a `subscription_events` row + an audit log
 * row + (where appropriate) returns the freshly-updated subscription.
 */
@Injectable()
export class UpgradeService {
  constructor(
    private readonly subRepo: SubscriptionsRepository,
    private readonly plansRepo: PlansRepository,
    private readonly eventsRepo: SubscriptionEventsRepository,
    private readonly auditLog: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  async upgradeOrDowngrade(
    tenantId: string,
    targetCode: PlanCode,
    userId: string,
  ): Promise<TenantSubscription> {
    const sub = await this.subRepo.findByTenant(tenantId);
    if (!sub) throw new DomainNotFoundException(SUBSCRIPTION_RESOURCE, tenantId);

    // NOTE: previously this threw "please reactivate or start fresh" for any
    // expired subscription — but no path back from 'expired' ever existed
    // ('reactivate' only handles 'cancelled', and there's no separate
    // "start fresh" flow). That meant a paying customer whose subscription
    // lapsed could never re-subscribe via the normal checkout: the payment
    // would be captured but `applyUpgrade` below would never run, silently
    // stranding them with no error surfaced to the client. `applyUpgrade`'s
    // guarded state list below now includes 'expired' so a fresh purchase
    // from this state works exactly like any other upgrade.
    if (sub.planCode === targetCode && sub.status !== 'cancelled' && sub.status !== 'expired') {
      // Same-plan no-op — return current state. We deliberately do
      // not throw, so idempotent retries from the mobile app stay
      // green.
      return sub;
    }

    const targetPlan = await this.plansRepo.findByCode(targetCode);
    if (!targetPlan) throw new DomainNotFoundException('SubscriptionPlan', targetCode);

    const direction = this.compareDirection(sub.planCode as PlanCode, targetCode);

    if (direction === 'downgrade') {
      return this.scheduleDowngrade(sub, targetPlan.id, targetCode, userId);
    }
    return this.applyUpgrade(sub, targetPlan.id, targetCode, targetPlan.price, userId);
  }

  /**
   * One-time 24-hour access pass — bought as a Razorpay one-time Order
   * (never a Razorpay Subscription), activated the moment the payment is
   * verified. Reuses the target plan's `planId`/entitlements exactly like
   * `applyUpgrade`, but:
   *   - the period is 24h, not 30 days;
   *   - `nextBillingDate` stays null — there is no auto-renewal, ever;
   *   - `metadata.packType = 'day_pass'` marks the row so
   *     `runRenewalsForDate` expires it outright instead of extending it
   *     like a monthly subscription.
   *
   * Allows transitioning from `expired` (unlike `upgradeOrDowngrade`,
   * which rejects it) — a lapsed/expired tenant wanting a cheap 24h taste
   * of the app is the primary day-pass use case.
   *
   * NOTE: `tenant_subscriptions` has exactly one row per tenant. A day-pass
   * purchase overwrites whatever plan the tenant was previously on. A
   * tenant with an *active paid monthly plan* who buys a day-pass by
   * mistake will have that monthly plan's id/code overwritten with no way
   * to restore it automatically — this is a real product edge case, not
   * just a theoretical one, and is called out in the deployment notes.
   */
  async activateDayPass(
    tenantId: string,
    planCode: PlanCode,
    userId: string,
  ): Promise<TenantSubscription> {
    const sub = await this.subRepo.findByTenant(tenantId);
    if (!sub) throw new DomainNotFoundException(SUBSCRIPTION_RESOURCE, tenantId);

    const plan = await this.plansRepo.findByCode(planCode);
    if (!plan) throw new DomainNotFoundException('SubscriptionPlan', planCode);

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const updated = await this.subRepo.updateStatusGuarded(
      sub.id,
      ['trial', 'active', 'cancelled', 'past_due', 'paused', 'expired'],
      {
        planId: plan.id,
        planCode,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        nextBillingDate: null,
        monthlyAmount: '0',
        cancelledAt: null,
        cancellationReason: null,
        pendingPlanId: null,
        pendingPlanCode: null,
        metadata: { ...(sub.metadata ?? {}), packType: 'day_pass' },
        updatedBy: userId,
      },
    );
    if (!updated) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Subscription state changed concurrently — please refresh and retry',
      );
    }

    await this.eventsRepo.create({
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      type: 'payment_succeeded',
      oldPlanCode: sub.planCode,
      newPlanCode: planCode,
      actorId: userId,
      notes: '24-hour day-pass activated',
      metadata: { packType: 'day_pass' },
    });
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: SUBSCRIPTION_RESOURCE,
      resourceId: sub.id,
      tenantId: sub.tenantId,
      userId,
      success: true,
      metadata: {
        transition: 'day_pass_activated',
        oldPlanCode: sub.planCode,
        newPlanCode: planCode,
      },
    });
    this.logger.info('subscription.day_pass.activated', {
      tenantId: sub.tenantId,
      planCode,
      expiresAt: periodEnd.toISOString(),
    });
    return updated;
  }

  async cancel(tenantId: string, reason: string, userId: string): Promise<TenantSubscription> {
    const sub = await this.subRepo.findByTenant(tenantId);
    if (!sub) throw new DomainNotFoundException(SUBSCRIPTION_RESOURCE, tenantId);

    if (sub.status === 'cancelled') {
      throw new DomainConflictException('Subscription is already cancelled', ErrorCode.CONFLICT, {
        metadata: { tenantId, cancelledAt: sub.cancelledAt?.toISOString() },
      });
    }
    if (sub.status === 'expired') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot cancel an expired subscription',
      );
    }

    const updated = await this.subRepo.updateStatusGuarded(
      sub.id,
      ['active', 'trial', 'past_due', 'paused'],
      {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: reason,
        updatedBy: userId,
      },
    );
    if (!updated) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Subscription state changed concurrently — please refresh and retry',
      );
    }

    await this.eventsRepo.create({
      tenantId,
      subscriptionId: sub.id,
      type: 'subscription_cancelled',
      oldPlanCode: sub.planCode,
      actorId: userId,
      notes: reason,
    });

    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: SUBSCRIPTION_RESOURCE,
      resourceId: sub.id,
      tenantId,
      userId,
      success: true,
      metadata: { transition: 'cancel', reason },
    });

    this.logger.info('subscription.cancelled', {
      tenantId,
      subscriptionId: sub.id,
      reason,
    });

    return updated;
  }

  async reactivate(tenantId: string, userId: string): Promise<TenantSubscription> {
    const sub = await this.subRepo.findByTenant(tenantId);
    if (!sub) throw new DomainNotFoundException(SUBSCRIPTION_RESOURCE, tenantId);

    if (sub.status !== 'cancelled') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot reactivate a subscription in '${sub.status}' state`,
      );
    }
    if (sub.currentPeriodEnd <= new Date()) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cancelled subscription period has elapsed — please start a new subscription',
      );
    }

    const updated = await this.subRepo.updateStatusGuarded(sub.id, ['cancelled'], {
      status: 'active',
      cancelledAt: null,
      cancellationReason: null,
      updatedBy: userId,
    });
    if (!updated) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Subscription state changed concurrently — please refresh and retry',
      );
    }

    await this.eventsRepo.create({
      tenantId,
      subscriptionId: sub.id,
      type: 'subscription_reactivated',
      newPlanCode: sub.planCode,
      actorId: userId,
    });

    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: SUBSCRIPTION_RESOURCE,
      resourceId: sub.id,
      tenantId,
      userId,
      success: true,
      metadata: { transition: 'reactivate' },
    });

    return updated;
  }

  /**
   * Renew or expire-at-cycle-end. Used by the renewal cron.
   * Returns:
   *   - renewed:  count of subs whose period was rolled forward
   *   - applied:  count of pending-downgrades that landed
   *   - expired:  count of cancelled subs flipped to expired
   */
  async runRenewalsForDate(now: Date = new Date()): Promise<{
    renewed: number;
    applied: number;
    expired: number;
  }> {
    let renewed = 0;
    let applied = 0;
    let expired = 0;

    // 1. Active subscriptions due for renewal — extend the period
    //    by 30 days. If a pending downgrade is staged, swap the plan
    //    at the same time.
    const dueActive = await this.subRepo.findRenewalsDue(now);
    for (const sub of dueActive) {
      try {
        if (this.isDayPass(sub.metadata)) {
          // One-time 24h pass — never auto-renews. Expire outright instead
          // of extending the period like a monthly subscription.
          const expiredSub = await this.subRepo.updateStatusGuarded(sub.id, ['active'], {
            status: 'expired',
          });
          if (!expiredSub) continue;
          await this.eventsRepo.create({
            tenantId: sub.tenantId,
            subscriptionId: sub.id,
            // Reuses `trial_expired` — the existing convention for
            // time-based expiry regardless of whether it was a trial (see
            // the `eolCancellations` branch below, which does the same).
            type: 'trial_expired',
            oldPlanCode: sub.planCode,
            notes: '24-hour day-pass elapsed',
            metadata: { packType: 'day_pass' },
          });
          await this.auditLog.logAction({
            action: 'UPDATE',
            resourceType: SUBSCRIPTION_RESOURCE,
            resourceId: sub.id,
            tenantId: sub.tenantId,
            userId: SYSTEM_ACTOR,
            success: true,
            metadata: { transition: 'day_pass_expired' },
          });
          expired += 1;
          continue;
        }

        const periodEnd = new Date(now);
        periodEnd.setDate(periodEnd.getDate() + 30);
        const patch: Record<string, unknown> = {
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          nextBillingDate: periodEnd,
          lastPaymentAt: now,
        };
        let eventType: 'subscription_renewed' | 'plan_downgraded' = 'subscription_renewed';
        let newPlanCode = sub.planCode;
        if (sub.pendingPlanId && sub.pendingPlanCode) {
          patch.planId = sub.pendingPlanId;
          patch.planCode = sub.pendingPlanCode;
          patch.pendingPlanId = null;
          patch.pendingPlanCode = null;
          eventType = 'plan_downgraded';
          newPlanCode = sub.pendingPlanCode;
          applied += 1;
        } else {
          renewed += 1;
        }
        const updated = await this.subRepo.updateStatusGuarded(sub.id, ['active'], patch);
        if (!updated) continue;
        await this.eventsRepo.create({
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          type: eventType,
          oldPlanCode: sub.planCode,
          newPlanCode,
          notes: eventType === 'plan_downgraded' ? 'Pending downgrade applied' : 'Period renewed',
        });
        await this.auditLog.logAction({
          action: 'UPDATE',
          resourceType: SUBSCRIPTION_RESOURCE,
          resourceId: sub.id,
          tenantId: sub.tenantId,
          userId: SYSTEM_ACTOR,
          success: true,
          metadata: {
            transition: eventType,
            oldPlanCode: sub.planCode,
            newPlanCode,
          },
        });
      } catch (err) {
        this.logger.error('subscription.renewal.failed', {
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    // 2. Cancelled subscriptions whose period has elapsed — flip
    //    to expired. The user paid for the period, so we honour it
    //    and only deny access from this point on.
    const eolCancellations = await this.subRepo.findEndOfCycleCancellations(now);
    for (const sub of eolCancellations) {
      try {
        const updated = await this.subRepo.updateStatusGuarded(sub.id, ['cancelled'], {
          status: 'expired',
        });
        if (!updated) continue;
        await this.eventsRepo.create({
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          type: 'trial_expired',
          oldPlanCode: sub.planCode,
          notes: 'Cancelled subscription period elapsed',
        });
        await this.auditLog.logAction({
          action: 'UPDATE',
          resourceType: SUBSCRIPTION_RESOURCE,
          resourceId: sub.id,
          tenantId: sub.tenantId,
          userId: SYSTEM_ACTOR,
          success: true,
          metadata: { transition: 'expired_after_cancel' },
        });
        expired += 1;
      } catch (err) {
        this.logger.error('subscription.expire.failed', {
          subscriptionId: sub.id,
          tenantId: sub.tenantId,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    return { renewed, applied, expired };
  }

  /* ─────────────────── Internals ─────────────────── */

  private isDayPass(metadata: unknown): boolean {
    return (
      typeof metadata === 'object' &&
      metadata !== null &&
      (metadata as Record<string, unknown>).packType === 'day_pass'
    );
  }

  private compareDirection(from: PlanCode, to: PlanCode): 'upgrade' | 'downgrade' {
    const fromIdx = PLAN_ORDER.indexOf(from);
    const toIdx = PLAN_ORDER.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return 'upgrade';
    return toIdx >= fromIdx ? 'upgrade' : 'downgrade';
  }

  private async applyUpgrade(
    sub: TenantSubscription,
    newPlanId: string,
    newPlanCode: PlanCode,
    monthlyAmount: string,
    userId: string,
  ): Promise<TenantSubscription> {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30);

    const updated = await this.subRepo.updateStatusGuarded(
      sub.id,
      ['trial', 'active', 'cancelled', 'past_due', 'paused', 'expired'],
      {
        planId: newPlanId,
        planCode: newPlanCode,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        monthlyAmount,
        cancelledAt: null,
        cancellationReason: null,
        pendingPlanId: null,
        pendingPlanCode: null,
        updatedBy: userId,
      },
    );
    if (!updated) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Subscription state changed concurrently — please refresh and retry',
      );
    }

    await this.eventsRepo.create({
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      type: 'plan_upgraded',
      oldPlanCode: sub.planCode,
      newPlanCode,
      amount: monthlyAmount,
      actorId: userId,
    });
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: SUBSCRIPTION_RESOURCE,
      resourceId: sub.id,
      tenantId: sub.tenantId,
      userId,
      success: true,
      metadata: {
        transition: 'plan_upgraded',
        oldPlanCode: sub.planCode,
        newPlanCode,
      },
    });
    this.logger.info('subscription.upgraded', {
      tenantId: sub.tenantId,
      from: sub.planCode,
      to: newPlanCode,
    });
    return updated;
  }

  private async scheduleDowngrade(
    sub: TenantSubscription,
    newPlanId: string,
    newPlanCode: PlanCode,
    userId: string,
  ): Promise<TenantSubscription> {
    const updated = await this.subRepo.updateStatusGuarded(
      sub.id,
      ['active', 'trial', 'past_due', 'paused'],
      {
        pendingPlanId: newPlanId,
        pendingPlanCode: newPlanCode,
        updatedBy: userId,
      },
    );
    if (!updated) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Subscription state changed concurrently — please refresh and retry',
      );
    }

    await this.eventsRepo.create({
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      type: 'plan_downgrade_scheduled',
      oldPlanCode: sub.planCode,
      newPlanCode,
      actorId: userId,
      notes: `Downgrade scheduled for ${sub.currentPeriodEnd.toISOString()}`,
    });
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: SUBSCRIPTION_RESOURCE,
      resourceId: sub.id,
      tenantId: sub.tenantId,
      userId,
      success: true,
      metadata: {
        transition: 'plan_downgrade_scheduled',
        oldPlanCode: sub.planCode,
        newPlanCode,
        effectiveAt: sub.currentPeriodEnd.toISOString(),
      },
    });
    this.logger.info('subscription.downgrade.scheduled', {
      tenantId: sub.tenantId,
      from: sub.planCode,
      to: newPlanCode,
      effectiveAt: sub.currentPeriodEnd.toISOString(),
    });
    return updated;
  }
}
