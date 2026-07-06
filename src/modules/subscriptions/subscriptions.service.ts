import { Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';

import { PlansRepository } from './repositories/plans.repository';
import { SubscriptionEventsRepository } from './repositories/subscription-events.repository';
import { SubscriptionsRepository } from './repositories/subscriptions.repository';
import { EntitlementService } from './services/entitlement.service';
import { PlanService } from './services/plan.service';
import { TrialService } from './services/trial.service';
import { UpgradeService } from './services/upgrade.service';
import type {
  EntitlementCheck,
  Feature,
  ISubscriptionsService,
  PlanCode,
  SubscriptionEventDto,
  SubscriptionPlanWithEntitlements,
  SubscriptionStatusResult,
  TenantSubscription,
  TenantSubscriptionWithPlan,
  UsageResult,
  UsageStats,
} from './types/subscription.types';

/**
 * BE-28 — Public subscription facade.
 *
 * Composes the dedicated sub-services into the single contract every
 * other module imports. Mirrors the BE-26 `GrnService` pattern — the
 * orchestrator only ever sees this class (or its DI token), never
 * the underlying `TrialService` / `UpgradeService` / `EntitlementService`.
 */
@Injectable()
export class SubscriptionsService implements ISubscriptionsService {
  constructor(
    private readonly subRepo: SubscriptionsRepository,
    private readonly plansRepo: PlansRepository,
    private readonly eventsRepo: SubscriptionEventsRepository,
    private readonly trial: TrialService,
    private readonly upgrade: UpgradeService,
    private readonly entitlement: EntitlementService,
    private readonly plan: PlanService,
  ) {}

  /* ─────────────────── Lifecycle ─────────────────── */

  startTrial(tenantId: string): Promise<TenantSubscription> {
    return this.trial.startTrial(tenantId);
  }

  upgradeToPlan(tenantId: string, planCode: PlanCode, userId: string): Promise<TenantSubscription> {
    return this.upgrade.upgradeOrDowngrade(tenantId, planCode, userId);
  }

  activateDayPass(
    tenantId: string,
    planCode: PlanCode,
    userId: string,
  ): Promise<TenantSubscription> {
    return this.upgrade.activateDayPass(tenantId, planCode, userId);
  }

  downgradeToPlan(
    tenantId: string,
    planCode: PlanCode,
    userId: string,
  ): Promise<TenantSubscription> {
    return this.upgrade.upgradeOrDowngrade(tenantId, planCode, userId);
  }

  cancel(tenantId: string, reason: string, userId: string): Promise<TenantSubscription> {
    return this.upgrade.cancel(tenantId, reason, userId);
  }

  reactivate(tenantId: string, userId: string): Promise<TenantSubscription> {
    return this.upgrade.reactivate(tenantId, userId);
  }

  /* ─────────────────── Queries ─────────────────── */

  async getCurrentSubscription(tenantId: string): Promise<TenantSubscriptionWithPlan | null> {
    const sub = await this.subRepo.findByTenant(tenantId);
    if (!sub) return null;
    const plan = await this.plansRepo.findById(sub.planId);
    if (!plan) return null;
    const planWithEnts = await this.plan.attachEntitlements(plan);
    return { ...sub, plan: planWithEnts };
  }

  async getStatus(tenantId: string): Promise<SubscriptionStatusResult> {
    const sub = await this.subRepo.findByTenant(tenantId);
    if (!sub) {
      throw new DomainNotFoundException('TenantSubscription', tenantId);
    }
    const plan = await this.plansRepo.findById(sub.planId);
    if (!plan) {
      throw new DomainNotFoundException('SubscriptionPlan', sub.planId);
    }
    const planWithEnts = await this.plan.attachEntitlements(plan);
    const usage = await this.entitlement.getCurrentUsage(tenantId);

    const features: SubscriptionStatusResult['features'] = {};
    const limits: SubscriptionStatusResult['limits'] = {};
    for (const f of planWithEnts.features) {
      features[f.feature] = f.limit === 'unlimited' || f.limit > 0;
      limits[f.feature] = f.limit;
    }

    const isActive = sub.status === 'trial' || sub.status === 'active';
    const trialDaysRemaining =
      sub.status === 'trial' ? await this.trial.getDaysRemaining(tenantId) : undefined;
    const daysUntilRenewal =
      sub.status === 'active' && sub.currentPeriodEnd
        ? Math.max(0, Math.ceil((sub.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
        : undefined;

    return {
      isActive,
      status: sub.status,
      plan: planWithEnts,
      trialDaysRemaining,
      daysUntilRenewal,
      features,
      limits,
      usage,
    };
  }

  /* ─────────────────── Plans ─────────────────── */

  listPlans(includePrivate = false): Promise<SubscriptionPlanWithEntitlements[]> {
    return this.plan.listPlans(includePrivate);
  }

  getPlan(code: PlanCode): Promise<SubscriptionPlanWithEntitlements> {
    return this.plan.getPlan(code);
  }

  /* ─────────────────── Entitlements ─────────────────── */

  checkEntitlement(tenantId: string, feature: Feature): Promise<EntitlementCheck> {
    return this.entitlement.checkEntitlement(tenantId, feature);
  }

  trackUsage(tenantId: string, feature: Feature, count?: number): Promise<UsageResult> {
    return this.entitlement.trackUsage(tenantId, feature, count);
  }

  getCurrentUsage(tenantId: string): Promise<UsageStats> {
    return this.entitlement.getCurrentUsage(tenantId);
  }

  /* ─────────────────── Events ─────────────────── */

  async recordEvent(dto: SubscriptionEventDto): Promise<void> {
    await this.eventsRepo.create({
      tenantId: dto.tenantId,
      subscriptionId: dto.subscriptionId,
      type: dto.type,
      oldPlanCode: dto.oldPlanCode,
      newPlanCode: dto.newPlanCode,
      amount: dto.amount !== undefined ? dto.amount.toString() : undefined,
      actorId: dto.actorId,
      notes: dto.notes,
      metadata: dto.metadata ?? {},
    });
  }
}
