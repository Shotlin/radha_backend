import type { Feature, PlanCode } from '../types/subscription.types';

/**
 * BE-28 — Default plan catalog.
 *
 * Source of truth for the seed script. Every entry follows the
 * spec's canonical shape: trial (₹0, 90d), starter (₹49), growth
 * (₹99), pro (₹199). Numeric limits use plain `number`; uncapped
 * features use `'unlimited'`.
 *
 * Adding a new plan here is the easy path — re-running
 * `pnpm db:seed:plans` upserts by `code` so existing tenant
 * subscriptions keep their plan_id stable.
 */

export interface DefaultPlanFeature {
  feature: Feature;
  limit: number | 'unlimited';
  description: string;
}

export interface DefaultPlan {
  code: PlanCode;
  name: string;
  price: number;
  trialDays: number;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
  description: string;
  features: DefaultPlanFeature[];
}

export const DEFAULT_PLANS: ReadonlyArray<DefaultPlan> = [
  {
    code: 'trial',
    name: 'Free Trial',
    price: 0,
    trialDays: 90,
    isPublic: false,
    isActive: true,
    sortOrder: 0,
    description: '3-month free trial with full features',
    features: [
      { feature: 'stores', limit: 1, description: '1 store' },
      { feature: 'users', limit: 5, description: '5 users' },
      { feature: 'monthly_scans', limit: 5_000, description: '5,000 scans/month' },
      { feature: 'monthly_reports', limit: 20, description: '20 reports/month' },
      { feature: 'ean_lists', limit: 5, description: '5 EAN lists' },
      { feature: 'ai_ocr', limit: 1_000, description: '1,000 AI OCR/month' },
      { feature: 'ai_label_analysis', limit: 50, description: '50 label scans/month' },
      { feature: 'llm_summaries', limit: 20, description: '20 AI summaries/month' },
      { feature: 'priority_support', limit: 0, description: 'Email support' },
      { feature: 'api_access', limit: 0, description: 'No API access' },
    ],
  },
  {
    code: 'starter',
    name: 'Starter',
    price: 49,
    trialDays: 0,
    isPublic: true,
    isActive: true,
    sortOrder: 1,
    description: 'For single-store retailers',
    features: [
      { feature: 'stores', limit: 1, description: '1 store' },
      { feature: 'users', limit: 5, description: '5 users' },
      { feature: 'monthly_scans', limit: 10_000, description: '10,000 scans/month' },
      { feature: 'monthly_reports', limit: 50, description: '50 reports/month' },
      { feature: 'ean_lists', limit: 10, description: '10 EAN lists' },
      { feature: 'ai_ocr', limit: 2_000, description: '2,000 AI OCR/month' },
      { feature: 'ai_label_analysis', limit: 100, description: '100 label scans/month' },
      { feature: 'llm_summaries', limit: 50, description: '50 AI summaries/month' },
      { feature: 'priority_support', limit: 0, description: 'Email support' },
      { feature: 'api_access', limit: 0, description: 'No API access' },
    ],
  },
  {
    code: 'growth',
    name: 'Growth',
    price: 99,
    trialDays: 0,
    isPublic: true,
    isActive: true,
    sortOrder: 2,
    description: 'For multi-store businesses',
    features: [
      { feature: 'stores', limit: 5, description: 'Up to 5 stores' },
      { feature: 'users', limit: 20, description: '20 users' },
      { feature: 'monthly_scans', limit: 50_000, description: '50,000 scans/month' },
      { feature: 'monthly_reports', limit: 200, description: '200 reports/month' },
      { feature: 'ean_lists', limit: 50, description: '50 EAN lists' },
      { feature: 'ai_ocr', limit: 10_000, description: '10,000 AI OCR/month' },
      { feature: 'ai_label_analysis', limit: 500, description: '500 label scans/month' },
      { feature: 'llm_summaries', limit: 200, description: '200 AI summaries/month' },
      { feature: 'priority_support', limit: 1, description: 'Priority email + chat' },
      { feature: 'advanced_analytics', limit: 1, description: 'Advanced analytics' },
      { feature: 'api_access', limit: 0, description: 'No API access' },
    ],
  },
  {
    code: 'pro',
    name: 'Pro',
    price: 199,
    trialDays: 0,
    isPublic: true,
    isActive: true,
    sortOrder: 3,
    description: 'For chains and enterprises',
    features: [
      { feature: 'stores', limit: 'unlimited', description: 'Unlimited stores' },
      { feature: 'users', limit: 'unlimited', description: 'Unlimited users' },
      { feature: 'monthly_scans', limit: 'unlimited', description: 'Unlimited scans' },
      { feature: 'monthly_reports', limit: 'unlimited', description: 'Unlimited reports' },
      { feature: 'ean_lists', limit: 'unlimited', description: 'Unlimited EAN lists' },
      { feature: 'ai_ocr', limit: 'unlimited', description: 'Unlimited AI OCR' },
      { feature: 'ai_label_analysis', limit: 5_000, description: '5,000 label scans/month' },
      { feature: 'llm_summaries', limit: 1_000, description: '1,000 AI summaries/month' },
      { feature: 'rekognition', limit: 1, description: 'AWS Rekognition enabled' },
      { feature: 'priority_support', limit: 1, description: 'Phone + WhatsApp support' },
      { feature: 'advanced_analytics', limit: 1, description: 'Full analytics suite' },
      { feature: 'custom_branding', limit: 1, description: 'White-label branding' },
      { feature: 'api_access', limit: 1, description: 'Full API access' },
    ],
  },
];

/** Plan ordering used by the upgrade-recommendation logic. */
export const PLAN_ORDER: ReadonlyArray<PlanCode> = ['trial', 'starter', 'growth', 'pro'];

/**
 * 1-Day Pass pricing — a one-time purchase granting 24h access to the
 * matching monthly plan's feature set. Not a separate `subscription_plans`
 * row: the day-pass reuses the monthly plan's id/entitlements (same
 * `planId`/`planCode`) and differs only in price and duration. Change
 * prices here only — `PaymentsService.createCheckout` reads this map
 * directly. Plans absent from this map (e.g. `trial`) have no day-pass.
 */
export const DAY_PASS_PRICING: Partial<Record<PlanCode, number>> = {
  starter: 3,
  growth: 5,
  pro: 9,
};
