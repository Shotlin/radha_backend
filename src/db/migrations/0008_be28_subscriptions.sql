-- BE-28 — Subscription & Entitlement Module
-- Tables: subscription_plans, plan_entitlements, tenant_subscriptions,
--         subscription_events, payment_intents
-- Enums:  subscription_status, subscription_event_type, payment_provider,
--         payment_intent_status
--
-- Numbering: 0008 follows BE-26's 0006_be26_grn.sql. BE-27 (Inventory)
-- holds 0007. BE-28 introduces the subscription tier — plans,
-- entitlements, tenant subscriptions, lifecycle events, and the
-- forward-looking payment-intent stub for Razorpay/Cashfree wiring.
--
-- Idempotent: every CREATE checks IF NOT EXISTS / DO blocks for enums
-- so the migration can be re-applied during development without
-- bricking the dev DB. The seed for default plans (4 rows) is the
-- separate `pnpm db:seed:plans` script — never an inline INSERT here,
-- so the orchestrator can re-run plan seeds independently.

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM (
    'trial',
    'active',
    'expired',
    'cancelled',
    'past_due',
    'paused'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE subscription_event_type AS ENUM (
    'trial_started',
    'trial_extended',
    'trial_expiring_soon',
    'trial_expired',
    'plan_upgraded',
    'plan_downgraded',
    'plan_downgrade_scheduled',
    'subscription_renewed',
    'subscription_cancelled',
    'subscription_reactivated',
    'subscription_paused',
    'subscription_resumed',
    'payment_succeeded',
    'payment_failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_provider AS ENUM (
    'razorpay',
    'cashfree',
    'stripe',
    'manual'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_intent_status AS ENUM (
    'pending',
    'authorized',
    'captured',
    'failed',
    'refunded',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────── subscription_plans ───────────────────

CREATE TABLE IF NOT EXISTS subscription_plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  code         VARCHAR(30) NOT NULL,
  name         VARCHAR(100) NOT NULL,
  description  VARCHAR(1000),
  price        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  yearly_price NUMERIC(10, 2),
  currency     VARCHAR(3) NOT NULL DEFAULT 'INR',
  trial_days   INTEGER NOT NULL DEFAULT 0,
  is_public    BOOLEAN NOT NULL DEFAULT TRUE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  metadata     JSONB DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_plans_code_unique
  ON subscription_plans (code);
CREATE INDEX IF NOT EXISTS subscription_plans_public_active_idx
  ON subscription_plans (is_public, is_active);

-- ─────────────────── plan_entitlements ───────────────────

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan_id      UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  feature      VARCHAR(50) NOT NULL,
  limit_value  INTEGER,
  is_unlimited BOOLEAN NOT NULL DEFAULT FALSE,
  description  VARCHAR(500),
  metadata     JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS plan_entitlements_plan_idx
  ON plan_entitlements (plan_id);
CREATE INDEX IF NOT EXISTS plan_entitlements_feature_idx
  ON plan_entitlements (feature);
CREATE UNIQUE INDEX IF NOT EXISTS plan_entitlements_plan_feature_unique
  ON plan_entitlements (plan_id, feature);

-- ─────────────────── tenant_subscriptions ───────────────────

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               UUID,
  updated_by               UUID,
  deleted_by               UUID,
  tenant_id                UUID NOT NULL,
  plan_id                  UUID NOT NULL,
  plan_code                VARCHAR(30) NOT NULL,
  status                   subscription_status NOT NULL DEFAULT 'trial',
  trial_started_at         TIMESTAMPTZ,
  trial_ends_at            TIMESTAMPTZ,
  current_period_start     TIMESTAMPTZ NOT NULL,
  current_period_end       TIMESTAMPTZ NOT NULL,
  cancelled_at             TIMESTAMPTZ,
  cancellation_reason      VARCHAR(500),
  monthly_amount           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  next_billing_date        TIMESTAMPTZ,
  payment_method           VARCHAR(50),
  last_payment_at          TIMESTAMPTZ,
  failed_payment_attempts  INTEGER NOT NULL DEFAULT 0,
  pending_plan_id          UUID,
  pending_plan_code        VARCHAR(30),
  metadata                 JSONB DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_subscriptions_tenant_unique
  ON tenant_subscriptions (tenant_id);
CREATE INDEX IF NOT EXISTS tenant_subscriptions_status_idx
  ON tenant_subscriptions (status);
CREATE INDEX IF NOT EXISTS tenant_subscriptions_trial_ends_idx
  ON tenant_subscriptions (trial_ends_at);
CREATE INDEX IF NOT EXISTS tenant_subscriptions_next_billing_idx
  ON tenant_subscriptions (next_billing_date);
CREATE INDEX IF NOT EXISTS tenant_subscriptions_plan_code_idx
  ON tenant_subscriptions (plan_code);

-- ─────────────────── subscription_events ───────────────────

CREATE TABLE IF NOT EXISTS subscription_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id       UUID NOT NULL,
  subscription_id UUID,
  type            subscription_event_type NOT NULL,
  old_plan_code   VARCHAR(30),
  new_plan_code   VARCHAR(30),
  amount          NUMERIC(10, 2),
  actor_id        UUID,
  notes           VARCHAR(1000),
  metadata        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS subscription_events_tenant_created_idx
  ON subscription_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS subscription_events_type_idx
  ON subscription_events (type);
CREATE INDEX IF NOT EXISTS subscription_events_subscription_idx
  ON subscription_events (subscription_id);

-- ─────────────────── payment_intents ───────────────────

CREATE TABLE IF NOT EXISTS payment_intents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL,
  subscription_id     UUID,
  provider            payment_provider NOT NULL DEFAULT 'manual',
  provider_payment_id VARCHAR(100),
  provider_order_id   VARCHAR(100),
  status              payment_intent_status NOT NULL DEFAULT 'pending',
  amount              NUMERIC(10, 2) NOT NULL,
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  description         VARCHAR(500),
  paid_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  failure_reason      VARCHAR(500),
  metadata            JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS payment_intents_tenant_idx
  ON payment_intents (tenant_id);
CREATE INDEX IF NOT EXISTS payment_intents_status_idx
  ON payment_intents (status);
CREATE INDEX IF NOT EXISTS payment_intents_subscription_idx
  ON payment_intents (subscription_id);
-- Partial unique: only enforce uniqueness when the provider id is set
-- (manual rows leave it null and may legitimately repeat).
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_provider_payment_unique
  ON payment_intents (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
