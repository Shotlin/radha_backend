-- BE-27 — Lightweight Inventory Module
-- Tables: inventory_items, inventory_batches, stock_movements,
--         low_stock_rules, low_stock_alerts, stock_counts,
--         stock_count_lines
-- Enums:  stock_movement_type, stock_movement_reason,
--         stock_count_status
--
-- Numbering: 0007 follows BE-26's 0006_be26_grn.sql per the phase
-- plan.
--
-- Idempotent: every CREATE checks IF NOT EXISTS / DO blocks for enums
-- so the migration can be re-applied during development without
-- bricking the dev DB.

BEGIN;

-- ─────────────────── Enums ───────────────────

DO $$ BEGIN
  CREATE TYPE stock_movement_type AS ENUM (
    'in',
    'out',
    'adjustment',
    'transfer'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_movement_reason AS ENUM (
    'grn_post',
    'grn_reversal',
    'manual_in',
    'sale',
    'expired',
    'damaged',
    'returned',
    'theft',
    'count_adjustment',
    'correction'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_count_status AS ENUM (
    'in_progress',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────── inventory_items ───────────────────

CREATE TABLE IF NOT EXISTS inventory_items (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                  TIMESTAMPTZ,
  created_by                  UUID,
  updated_by                  UUID,
  deleted_by                  UUID,

  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,
  product_id                  UUID NOT NULL,

  quantity                    INTEGER NOT NULL DEFAULT 0,
  reserved_quantity           INTEGER NOT NULL DEFAULT 0,
  available_quantity          INTEGER NOT NULL DEFAULT 0,

  low_stock_threshold         INTEGER,
  is_low_stock                INTEGER NOT NULL DEFAULT 0,

  last_movement_at            TIMESTAMPTZ,
  last_in_at                  TIMESTAMPTZ,
  last_out_at                 TIMESTAMPTZ,

  total_in                    INTEGER NOT NULL DEFAULT 0,
  total_out                   INTEGER NOT NULL DEFAULT 0,

  average_unit_cost           NUMERIC(10, 2),

  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_product_store
  ON inventory_items (product_id, store_id);
CREATE INDEX IF NOT EXISTS idx_inventory_tenant_store
  ON inventory_items (tenant_id, store_id);
CREATE INDEX IF NOT EXISTS idx_inventory_store
  ON inventory_items (store_id);
CREATE INDEX IF NOT EXISTS idx_inventory_low_stock
  ON inventory_items (store_id, is_low_stock);

-- ─────────────────── inventory_batches ───────────────────

CREATE TABLE IF NOT EXISTS inventory_batches (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  inventory_item_id           UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,
  product_id                  UUID NOT NULL,

  batch_number                VARCHAR(100),

  quantity                    INTEGER NOT NULL DEFAULT 0,

  expiry_date                 TIMESTAMPTZ,
  manufacture_date            TIMESTAMPTZ,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  source_type                 VARCHAR(30),
  source_id                   UUID,

  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_batches_inventory_item
  ON inventory_batches (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_batches_product_store
  ON inventory_batches (product_id, store_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry
  ON inventory_batches (expiry_date);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_batches_product_store_batch
  ON inventory_batches (product_id, store_id, batch_number)
  WHERE batch_number IS NOT NULL;

-- ─────────────────── stock_movements ───────────────────

CREATE TABLE IF NOT EXISTS stock_movements (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,
  product_id                  UUID NOT NULL,
  inventory_item_id           UUID,

  type                        stock_movement_type NOT NULL,
  reason                      stock_movement_reason NOT NULL,

  quantity                    INTEGER NOT NULL,
  quantity_before             INTEGER NOT NULL,
  quantity_after              INTEGER NOT NULL,

  batch_number                VARCHAR(100),
  inventory_batch_id          UUID,

  source_type                 VARCHAR(30),
  source_id                   UUID,

  unit_cost                   NUMERIC(10, 2),
  total_cost                  NUMERIC(14, 2),

  user_id                     UUID NOT NULL,

  notes                       VARCHAR(500),
  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_movements_product_store_created
  ON stock_movements (product_id, store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_store_created
  ON stock_movements (store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_tenant_created
  ON stock_movements (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_type
  ON stock_movements (type);
CREATE INDEX IF NOT EXISTS idx_movements_source
  ON stock_movements (source_type, source_id);

-- ─────────────────── low_stock_rules ───────────────────

CREATE TABLE IF NOT EXISTS low_stock_rules (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                  TIMESTAMPTZ,
  created_by                  UUID,
  updated_by                  UUID,
  deleted_by                  UUID,

  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,

  product_id                  UUID,
  category                    VARCHAR(100),

  threshold                   INTEGER NOT NULL,
  enabled                     INTEGER NOT NULL DEFAULT 1,
  notes                       VARCHAR(500),

  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_low_stock_rules_tenant_store
  ON low_stock_rules (tenant_id, store_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_low_stock_rules_product_store
  ON low_stock_rules (product_id, store_id)
  WHERE product_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_low_stock_rules_category_store
  ON low_stock_rules (category, store_id)
  WHERE category IS NOT NULL AND deleted_at IS NULL;

-- ─────────────────── low_stock_alerts ───────────────────

CREATE TABLE IF NOT EXISTS low_stock_alerts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,
  product_id                  UUID NOT NULL,
  inventory_item_id           UUID,

  threshold                   INTEGER NOT NULL,
  current_quantity            INTEGER NOT NULL,

  notified_at                 TIMESTAMPTZ,
  resolved_at                 TIMESTAMPTZ,

  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_low_stock_alerts_tenant_store
  ON low_stock_alerts (tenant_id, store_id);
CREATE INDEX IF NOT EXISTS idx_low_stock_alerts_store_product
  ON low_stock_alerts (store_id, product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_low_stock_alerts_active
  ON low_stock_alerts (product_id, store_id)
  WHERE resolved_at IS NULL;

-- ─────────────────── stock_counts ───────────────────

CREATE TABLE IF NOT EXISTS stock_counts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  UUID,
  updated_by                  UUID,
  deleted_by                  UUID,

  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,

  status                      stock_count_status NOT NULL DEFAULT 'in_progress',

  started_at                  TIMESTAMPTZ NOT NULL,
  completed_at                TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,

  notes                       VARCHAR(1000),

  total_products              INTEGER NOT NULL DEFAULT 0,
  variances                   INTEGER NOT NULL DEFAULT 0,
  total_variance_quantity     INTEGER NOT NULL DEFAULT 0,
  adjustments_created         INTEGER NOT NULL DEFAULT 0,

  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_stock_counts_tenant_store
  ON stock_counts (tenant_id, store_id);
CREATE INDEX IF NOT EXISTS idx_stock_counts_store_status
  ON stock_counts (store_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_counts_started
  ON stock_counts (started_at);

-- ─────────────────── stock_count_lines ───────────────────

CREATE TABLE IF NOT EXISTS stock_count_lines (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  stock_count_id              UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,
  product_id                  UUID NOT NULL,

  system_quantity             INTEGER NOT NULL,
  counted_quantity            INTEGER NOT NULL,
  variance                    INTEGER NOT NULL,

  notes                       VARCHAR(500),

  adjustment_movement_id      UUID,

  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_stock_count_lines_count
  ON stock_count_lines (stock_count_id);
CREATE INDEX IF NOT EXISTS idx_stock_count_lines_product
  ON stock_count_lines (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_stock_count_lines_count_product
  ON stock_count_lines (stock_count_id, product_id);

COMMIT;
