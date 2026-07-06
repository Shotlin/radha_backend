import { Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';

import { PlanEntitlementsRepository } from '../repositories/plan-entitlements.repository';
import { PlansRepository } from '../repositories/plans.repository';
import type {
  Feature,
  PlanCode,
  PlanFeature,
  SubscriptionPlan,
  SubscriptionPlanWithEntitlements,
} from '../types/subscription.types';

/**
 * BE-28 — Plan-level reads.
 *
 * Combines `subscription_plans` with `plan_entitlements` to yield a
 * fully-resolved `SubscriptionPlanWithEntitlements` object. The
 * results are intentionally not cached at this layer — the
 * repositories are already cheap (one indexed lookup each), and
 * upstream callers (status response, entitlement guard) cache the
 * `tenantSubscription` row themselves when they need it.
 */
@Injectable()
export class PlanService {
  constructor(
    private readonly plansRepo: PlansRepository,
    private readonly entitlementsRepo: PlanEntitlementsRepository,
  ) {}

  async listPlans(includePrivate = false): Promise<SubscriptionPlanWithEntitlements[]> {
    const plans = await this.plansRepo.listActive(includePrivate);
    const out: SubscriptionPlanWithEntitlements[] = [];
    for (const plan of plans) {
      out.push(await this.attachEntitlements(plan));
    }
    return out;
  }

  async getPlan(code: PlanCode): Promise<SubscriptionPlanWithEntitlements> {
    const plan = await this.plansRepo.findByCode(code);
    if (!plan) {
      throw new DomainNotFoundException('SubscriptionPlan', code);
    }
    return this.attachEntitlements(plan);
  }

  async getPlanById(id: string): Promise<SubscriptionPlanWithEntitlements> {
    const plan = await this.plansRepo.findById(id);
    if (!plan) {
      throw new DomainNotFoundException('SubscriptionPlan', id);
    }
    return this.attachEntitlements(plan);
  }

  /**
   * Public helper — composes a plan row with its entitlement rows.
   * Exposed so the trial / upgrade services can reuse the same
   * shape without going through the repos directly.
   */
  async attachEntitlements(plan: SubscriptionPlan): Promise<SubscriptionPlanWithEntitlements> {
    const ents = await this.entitlementsRepo.findByPlan(plan.id);
    const features: PlanFeature[] = ents.map((e) => ({
      feature: e.feature as Feature,
      limit: e.isUnlimited ? 'unlimited' : (e.limitValue ?? 0),
      description: e.description ?? '',
    }));
    return { ...plan, features };
  }
}
