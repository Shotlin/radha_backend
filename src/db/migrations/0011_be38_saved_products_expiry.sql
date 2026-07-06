-- BE-38: Expiry Calendar (Consumer) — saved_products table + expiry columns
-- Creates saved_products if not exists, adds expires_at and marked_consumed_at columns.

CREATE TABLE IF NOT EXISTS saved_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  product_name TEXT NOT NULL,
  product_id UUID,
  barcode TEXT,
  expires_at DATE,
  marked_consumed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- If table already exists, add columns idempotently
ALTER TABLE saved_products
  ADD COLUMN IF NOT EXISTS expires_at DATE,
  ADD COLUMN IF NOT EXISTS marked_consumed_at TIMESTAMPTZ;

-- Partial index for active (non-consumed) products per user, sorted by expiry
CREATE INDEX IF NOT EXISTS idx_saved_products_user_expires
  ON saved_products(user_id, expires_at)
  WHERE marked_consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_saved_products_user_id
  ON saved_products(user_id);
