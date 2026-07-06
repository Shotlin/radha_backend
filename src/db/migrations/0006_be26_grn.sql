-- BE-26 — GRN (Goods Receipt Note) Module
-- Tables: grn_headers, grn_items, grn_events
-- Enums:  grn_status, grn_event_type
--
-- Numbering: 0006 follows BE-25's 0005_be25_suppliers.sql per the
-- phase plan. BE-15..BE-18 reused existing tables and shipped no
-- standalone migration, which leaves an apparent gap (0003 → 0006);
-- BE-24/BE-25 land in the same wave and fill 0004/0005.
--
-- Idempotent: every CREATE checks IF NOT EXISTS / DO blocks for enums
-- so the migration can be re-applied during development without
-- bricking the dev DB.

DO $$ BEGIN
  CREATE TYPE grn_status AS ENUM (
    'draft',
    'pending_review',
    'posted',
    'cancelled',
    'reversed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grn_event_type AS ENUM (
    'created',
    'updated',
    'item_added',
    'item_updated',
    'item_removed',
    'submitted_for_review',
    'approved',
    'posted',
    'cancelled',
    'reversed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS grn_headers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                  TIMESTAMPTZ,
  created_by                  UUID,
  updated_by                  UUID,
  deleted_by                  UUID,
  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,
  grn_number                  VARCHAR(50) NOT NULL,
  supplier_id                 UUID NOT NULL,
  invoice_number              VARCHAR(100) NOT NULL,
  invoice_date                TIMESTAMPTZ NOT NULL,
  po_number                   VARCHAR(100),
  inward_date                 TIMESTAMPTZ NOT NULL,
  expected_delivery_date      TIMESTAMPTZ,
  order_date                  TIMESTAMPTZ,
  status                      grn_status NOT NULL DEFAULT 'draft',
  subtotal                    NUMERIC(14, 2),
  tax_amount                  NUMERIC(14, 2),
  total_amount                NUMERIC(14, 2),
  total_items                 INTEGER NOT NULL DEFAULT 0,
  total_quantity              INTEGER NOT NULL DEFAULT 0,
  min_expiry_remaining_days   INTEGER,
  short_shelf_life_count      INTEGER NOT NULL DEFAULT 0,
  posted_at                   TIMESTAMPTZ,
  posted_by                   UUID,
  cancelled_at                TIMESTAMPTZ,
  cancelled_by                UUID,
  cancellation_reason         VARCHAR(500),
  reversed_at                 TIMESTAMPTZ,
  reversed_by                 UUID,
  reversal_reason             VARCHAR(500),
  notes                       VARCHAR(2000),
  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_grn_tenant_store_status_date
  ON grn_headers (tenant_id, store_id, status, inward_date);
CREATE INDEX IF NOT EXISTS idx_grn_supplier_date
  ON grn_headers (supplier_id, inward_date);
CREATE INDEX IF NOT EXISTS idx_grn_invoice
  ON grn_headers (invoice_number);
CREATE INDEX IF NOT EXISTS idx_grn_status
  ON grn_headers (status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_grn_number_tenant
  ON grn_headers (tenant_id, grn_number);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_grn_invoice_supplier
  ON grn_headers (supplier_id, invoice_number);

CREATE TABLE IF NOT EXISTS grn_items (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  grn_id                      UUID NOT NULL REFERENCES grn_headers(id) ON DELETE CASCADE,
  tenant_id                   UUID NOT NULL,
  store_id                    UUID NOT NULL,
  product_id                  UUID,
  ean                         VARCHAR(13) NOT NULL,
  product_name_snapshot       VARCHAR(200),
  quantity                    INTEGER NOT NULL,
  unit                        VARCHAR(20) NOT NULL DEFAULT 'pcs',
  batch_number                VARCHAR(100),
  manufacture_date            TIMESTAMPTZ,
  expiry_date                 TIMESTAMPTZ,
  expiry_remaining_days       INTEGER,
  unit_price                  NUMERIC(10, 2),
  tax_percent                 NUMERIC(5, 2),
  total_price                 NUMERIC(14, 2),
  expiry_record_id            UUID,
  inventory_item_id           UUID,
  stock_movement_id           UUID,
  notes                       VARCHAR(500),
  metadata                    JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_grn_items_grn      ON grn_items (grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_items_ean      ON grn_items (ean);
CREATE INDEX IF NOT EXISTS idx_grn_items_product  ON grn_items (product_id);
CREATE INDEX IF NOT EXISTS idx_grn_items_batch    ON grn_items (batch_number);
-- Partial uniqueness: same EAN + batch can't appear twice on one GRN
-- when batch is provided. Items without a batch number are allowed
-- to repeat (e.g. multiple unbatched line splits).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_grn_item_grn_ean_batch
  ON grn_items (grn_id, ean, batch_number)
  WHERE batch_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS grn_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  grn_id       UUID NOT NULL REFERENCES grn_headers(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  type         grn_event_type NOT NULL,
  actor_id     UUID NOT NULL,
  notes        VARCHAR(1000),
  metadata     JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_grn_events_grn_created
  ON grn_events (grn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_grn_events_type
  ON grn_events (type);
CREATE INDEX IF NOT EXISTS idx_grn_events_tenant
  ON grn_events (tenant_id);
