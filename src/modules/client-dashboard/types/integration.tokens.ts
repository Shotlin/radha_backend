/**
 * BE-30 — Cross-phase DI tokens.
 *
 * BE-27 (Inventory) and BE-28 (Subscriptions) ship in the same wave
 * as BE-30. They will eventually own the real implementations of
 * the contracts declared here, but the dashboard module needs to
 * boot and run before they're merged. The pattern mirrors BE-26 GRN:
 *
 *   1. Declare a `Symbol`-based DI token here.
 *   2. Bind it to an in-process stub inside `client-dashboard.module.ts`.
 *   3. Once the sibling phase ships, the orchestrator overrides the
 *      provider in the root composition. The dashboard module is
 *      unaffected.
 *
 * Both tokens are read-only: the dashboard never writes inventory
 * or subscription state, only reads aggregated metrics. That keeps
 * the cross-phase contract narrow and easy to override.
 */

/* ─────────────────── BE-27 — Inventory accuracy metrics ─────────────────── */

/**
 * BE-27 contract — read-only inventory variance + count metrics
 * consumed by the Inventory Accuracy calculator (OHS component, 20%
 * weight). The implementation will be wired by BE-27's
 * `InventoryAccuracyMetricsQuery` service.
 */
export const INVENTORY_ACCURACY_METRICS_QUERY = Symbol('INVENTORY_ACCURACY_METRICS_QUERY');

export interface InventoryAccuracyMetricsInput {
  tenantId: string;
  storeId: string;
  /** End date of the rolling window, inclusive. */
  asOf: Date;
  /** Length of the rolling window in days; the calculator uses 30. */
  windowDays: number;
}

export interface InventoryAccuracyMetrics {
  /**
   * Variance rate over the window — `|expected − actual| / expected`
   * across all stock counts. Range [0, 1]. The calculator scores
   * `1 - varianceRate`.
   */
  varianceRate: number;
  /** Number of physical stock counts performed in the window. */
  countsPerformed: number;
  /** The window length the metric was computed over. */
  windowDays: number;
}

export interface IInventoryAccuracyMetricsQuery {
  getMetrics(input: InventoryAccuracyMetricsInput): Promise<InventoryAccuracyMetrics>;
}

/* ─────────────────── BE-28 — Subscription status ─────────────────── */

/**
 * BE-28 contract — minimal subscription read used by the dashboard
 * to render the subscription card and to gate quick actions.
 *
 * The mobile dashboard surfaces:
 *   - the plan code (trial / starter / growth / pro),
 *   - lifecycle status (`trial`, `active`, `past_due`, `cancelled`),
 *   - days remaining if still in trial,
 *   - per-feature usage so the quick-action service can disable an
 *     action when the tenant has hit a limit (e.g. `ai_ocr_uses`).
 */
export const SUBSCRIPTIONS_SERVICE_TOKEN = Symbol('SUBSCRIPTIONS_SERVICE_TOKEN');

export type SubscriptionLifecycleStatus = 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';

export interface SubscriptionPlanRef {
  code: string;
  /** Optional display name; falls back to `code` when absent. */
  name?: string;
}

export interface SubscriptionFeatureUsage {
  /** 0..100 percentage of the feature's monthly limit consumed. */
  percentageUsed: number;
  /** Whether the feature is currently blocked because the limit is hit. */
  blocked?: boolean;
  /** Free-form reason populated when `blocked = true`. */
  reason?: string;
}

export interface SubscriptionUsage {
  byFeature: Record<string, SubscriptionFeatureUsage>;
}

export interface SubscriptionStatus {
  status: SubscriptionLifecycleStatus;
  plan: SubscriptionPlanRef;
  /** Populated only when `status = 'trial'`. */
  trialDaysRemaining?: number;
  usage: SubscriptionUsage;
}

export interface ISubscriptionsService {
  getStatus(tenantId: string): Promise<SubscriptionStatus>;
}
