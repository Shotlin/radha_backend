-- BE-28 v2 — Razorpay Payments Integration
-- Tables: razorpay_orders, payment_webhooks_inbox
--
-- Numbering: 0028 follows 0027_be56_barcode_learning.sql. Razorpay
-- (Indian payment gateway) lights up the existing subscription
-- module with real money. The legacy `payment_intents` ledger
-- (migration 0008) stays in place for the manual/Cashfree/Stripe
-- providers — this v2 migration adds Razorpay-specific tables
-- without touching it.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-applying the
-- migration during dev never bricks the schema.

-- ─────────────────── razorpay_orders ───────────────────
-- One row per /api/v1/payments/checkout call. Lifecycle is:
--   created  → authorised  → captured  → refunded
--                                     ↘ failed
-- `tenant_id` is nullable to accommodate consumer-tier payments
-- whose personal tenant isn't bootstrapped yet (BE-09 v2).
CREATE TABLE IF NOT EXISTS razorpay_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID,
  user_id             UUID NOT NULL,
  plan_id             UUID NOT NULL,
  razorpay_order_id   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'created',
  amount_paise        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  notes               JSONB,
  razorpay_payment_id TEXT,
  posted_at           TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS razorpay_orders_order_id_unique
  ON razorpay_orders (razorpay_order_id);

-- Composite indexes lead with `tenant_id` per architecture funnel
-- rules. The `(user_id, status)` index covers the consumer hot
-- path ("show me my pending checkout"); the plan index supports
-- BE-31 owner dashboard rollups.
CREATE INDEX IF NOT EXISTS razorpay_orders_tenant_status_idx
  ON razorpay_orders (tenant_id, status);
CREATE INDEX IF NOT EXISTS razorpay_orders_user_status_idx
  ON razorpay_orders (user_id, status);
CREATE INDEX IF NOT EXISTS razorpay_orders_plan_idx
  ON razorpay_orders (plan_id);
CREATE INDEX IF NOT EXISTS razorpay_orders_created_at_idx
  ON razorpay_orders (created_at DESC);

-- ─────────────────── payment_webhooks_inbox ───────────────────
-- Idempotency anchor. The unique constraint on event_id is what
-- makes the webhook handler safe under provider retries.
CREATE TABLE IF NOT EXISTS payment_webhooks_inbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  signature         TEXT NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  processing_error  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_webhooks_inbox_event_id_unique
  ON payment_webhooks_inbox (event_id);

-- Hot path: BE-31 owner dashboard "latest payment events" widget.
CREATE INDEX IF NOT EXISTS payment_webhooks_inbox_provider_type_received_idx
  ON payment_webhooks_inbox (provider, event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS payment_webhooks_inbox_received_idx
  ON payment_webhooks_inbox (received_at DESC);
