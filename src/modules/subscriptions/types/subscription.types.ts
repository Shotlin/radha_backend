import type { PlanEntitlementRow } from '@/db/schema/plan-entitlements';
import type { SubscriptionEventRow } from '@/db/schema/subscription-events';
import type { SubscriptionPlanRow } from '@/db/schema/subscription-plans';
import type { TenantSubscriptionRow } from '@/db/schema/tenant-subscriptions';

/**
 * BE-28 — Public subscription types.
 *
 * Drizzle row types are re-exported under shorter names so the
 * service layer doesn't reach into `db/schema/*` directly. The
 * canonical lists (`Feature`, `PlanCode`, `SubscriptionStatus`,
 * `SubscriptionEventType`) are also defined here as TypeScript
 * unions so callers don't have to import the pgEnum literals.
 */

/** Re-exported row aliases */
export type SubscriptionPlan = SubscriptionPlanRow;
export type PlanEntitlement = PlanEntitlementRow;
export type TenantSubscription = TenantSubscriptionRow;
export type SubscriptionEvent = SubscriptionEventRow;

/* ─────────────────── Status / plan / feature unions ─────────────────── */

export type SubscriptionStatus =
  | 'trial'
  | 'active'
  | 'expired'
  | 'cancelled'
  | 'past_due'
  | 'paused';

export type PlanCode = 'trial' | 'starter' | 'growth' | 'pro' | 'enterprise';

/**
 * Canonical feature list. Adding a new feature is a code change
 * (this union) plus a seed update — the DB column is a free
 * varchar so the migration is unaffected.
 */
export type Feature =
  | 'stores'
  | 'users'
  | 'monthly_scans'
  | 'monthly_reports'
  | 'ean_lists'
  | 'ai_ocr'
  | 'ai_label_analysis'
  | 'llm_summaries'
  | 'rekognition'
  | 'priority_support'
  | 'custom_branding'
  | 'api_access'
  | 'advanced_analytics';

export const ALL_FEATURES: readonly Feature[] = [
  'stores',
  'users',
  'monthly_scans',
  'monthly_reports',
  'ean_lists',
  'ai_ocr',
  'ai_label_analysis',
  'llm_summaries',
  'rekognition',
  'priority_support',
  'custom_branding',
  'api_access',
  'advanced_analytics',
];

export type SubscriptionEventType =
  | 'trial_started'
  | 'trial_extended'
  | 'trial_expiring_soon'
  | 'trial_expired'
  | 'plan_upgraded'
  | 'plan_downgraded'
  | 'plan_downgrade_scheduled'
  | 'subscription_renewed'
  | 'subscription_cancelled'
  | 'subscription_reactivated'
  | 'subscription_paused'
  | 'subscription_resumed'
  | 'payment_succeeded'
  | 'payment_failed';

/* ─────────────────── Composite read shapes ─────────────────── */

export interface PlanFeature {
  feature: Feature;
  limit: number | 'unlimited';
  description: string;
}

export interface SubscriptionPlanWithEntitlements extends SubscriptionPlan {
  features: PlanFeature[];
}

export interface TenantSubscriptionWithPlan extends TenantSubscription {
  plan: SubscriptionPlanWithEntitlements;
}

/* ─────────────────── Entitlement results ─────────────────── */

export interface EntitlementCheck {
  allowed: boolean;
  feature: Feature;
  currentUsage: number;
  limit: number | 'unlimited';
  remaining: number | 'unlimited';
  resetAt?: Date;
  reason?: string;
  upgradeRequired?: boolean;
  recommendedPlan?: PlanCode;
}

export interface UsageResult {
  feature: Feature;
  newUsage: number;
  limit: number | 'unlimited';
  remaining: number | 'unlimited';
  warningTriggered?: boolean;
}

export interface UsageStats {
  tenantId: string;
  period: { from: Date; to: Date };
  byFeature: Partial<
    Record<
      Feature,
      {
        used: number;
        limit: number | 'unlimited';
        percentageUsed: number;
      }
    >
  >;
}

export interface SubscriptionStatusResult {
  isActive: boolean;
  status: SubscriptionStatus;
  plan: SubscriptionPlanWithEntitlements;
  trialDaysRemaining?: number;
  daysUntilRenewal?: number;
  features: Partial<Record<Feature, boolean>>;
  limits: Partial<Record<Feature, number | 'unlimited'>>;
  usage: UsageStats;
}

/* ─────────────────── DTOs (mirrored, dto folder owns Zod) ─────────────────── */

export interface SubscriptionEventDto {
  tenantId: string;
  type: SubscriptionEventType;
  subscriptionId?: string;
  oldPlanCode?: PlanCode;
  newPlanCode?: PlanCode;
  amount?: number;
  actorId?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

/* ─────────────────── Service contract ─────────────────── */

export interface ISubscriptionsService {
  // Lifecycle
  startTrial(tenantId: string): Promise<TenantSubscription>;
  upgradeToPlan(tenantId: string, planCode: PlanCode, userId: string): Promise<TenantSubscription>;
  /**
   * One-time 24-hour access pass. Unlike `upgradeToPlan`, this never sets
   * `nextBillingDate` — the renewal cron expires it outright instead of
   * rolling the period forward, so re-access always requires a fresh
   * purchase.
   */
  activateDayPass(
    tenantId: string,
    planCode: PlanCode,
    userId: string,
  ): Promise<TenantSubscription>;
  downgradeToPlan(
    tenantId: string,
    planCode: PlanCode,
    userId: string,
  ): Promise<TenantSubscription>;
  cancel(tenantId: string, reason: string, userId: string): Promise<TenantSubscription>;
  reactivate(tenantId: string, userId: string): Promise<TenantSubscription>;

  // Queries
  getCurrentSubscription(tenantId: string): Promise<TenantSubscriptionWithPlan | null>;
  getStatus(tenantId: string): Promise<SubscriptionStatusResult>;

  // Plans
  listPlans(includePrivate?: boolean): Promise<SubscriptionPlanWithEntitlements[]>;
  getPlan(code: PlanCode): Promise<SubscriptionPlanWithEntitlements>;

  // Entitlements
  checkEntitlement(tenantId: string, feature: Feature): Promise<EntitlementCheck>;
  trackUsage(tenantId: string, feature: Feature, count?: number): Promise<UsageResult>;
  getCurrentUsage(tenantId: string): Promise<UsageStats>;

  // Events
  recordEvent(dto: SubscriptionEventDto): Promise<void>;
}
