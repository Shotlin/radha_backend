-- BE-39: Recall Alert Sweep + FSSAI Feed
-- Adds `recall_feed_entries` (denormalised cache of upstream
-- publisher rows) and `recall_alerts` (per-user matches generated
-- by the daily Recall_Sweep_Job). `recall_alerts` is idempotent on
-- (user_id, recall_feed_entry_id, saved_product_id).

CREATE TABLE IF NOT EXISTS recall_feed_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  ean TEXT,
  brand TEXT,
  product_name TEXT,
  batch_number TEXT,
  reason TEXT NOT NULL,
  recalled_at DATE NOT NULL,
  raw JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recall_feed_ean
  ON recall_feed_entries(ean);

CREATE INDEX IF NOT EXISTS idx_recall_feed_source_recalled_at
  ON recall_feed_entries(source, recalled_at);

CREATE TABLE IF NOT EXISTS recall_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_product_id UUID REFERENCES saved_products(id) ON DELETE CASCADE,
  recall_feed_entry_id UUID NOT NULL REFERENCES recall_feed_entries(id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recall_alerts_user_entry_product_unique
    UNIQUE (user_id, recall_feed_entry_id, saved_product_id)
);

CREATE INDEX IF NOT EXISTS idx_recall_alerts_user_created
  ON recall_alerts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recall_alerts_tenant_user
  ON recall_alerts(tenant_id, user_id);

ALTER TABLE recall_alerts ENABLE ROW LEVEL SECURITY;
