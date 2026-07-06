-- BE-25 — Suppliers / vendor directory.
--
-- NOTE on numbering: this migration is intentionally numbered 0005,
-- leaving 0004 for BE-24 (Notifications & Background Jobs) which has
-- yet to ship its DDL. The migration runner sorts by filename so the
-- gap is harmless once BE-24 lands.
--
-- Three tables + 1 enum:
--   * `supplier_status` enum (active | inactive | blacklisted | pending)
--   * `suppliers`            — tenant-scoped vendor master.
--   * `supplier_contacts`    — many contacts per supplier.
--   * `supplier_performance` — append-only per-GRN metric snapshots.
--
-- Soft-delete + audit columns on `suppliers` and `supplier_contacts`.
-- `supplier_performance` is append-only (no soft-delete column).
--
-- Concurrency invariants enforced at the DB level:
--   * exactly one **primary** active contact per supplier via partial
--     unique index `idx_supplier_contacts_primary_uniq`.
--   * `(tenant_id, code)` unique among non-deleted suppliers.
--   * `(tenant_id, gst_number)` unique among non-deleted suppliers
--     when `gst_number` is supplied.
--
-- Idempotent: every CREATE / ALTER guards itself with IF NOT EXISTS or
-- DO blocks so a re-run is safe.

BEGIN;

-- ─────────────────── Enums ───────────────────

DO $$ BEGIN
  CREATE TYPE supplier_status AS ENUM (
    'active',
    'inactive',
    'blacklisted',
    'pending'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────── suppliers ───────────────────

CREATE TABLE IF NOT EXISTS suppliers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  created_by                  uuid,
  updated_by                  uuid,
  deleted_by                  uuid,

  tenant_id                   uuid NOT NULL,

  name                        varchar(200) NOT NULL,
  legal_name                  varchar(200),
  code                        varchar(50) NOT NULL,

  gst_number                  varchar(15),
  pan_number                  varchar(10),

  category                    varchar(100),
  description                 varchar(1000),

  status                      supplier_status NOT NULL DEFAULT 'pending',
  blacklist_reason            varchar(500),
  blacklisted_at              timestamptz,

  email                       varchar(255),
  phone                       varchar(20),
  alternate_phone             varchar(20),
  whatsapp_number             varchar(20),

  address_line_1              varchar(255),
  address_line_2              varchar(255),
  city                        varchar(100),
  state                       varchar(100),
  pincode                     varchar(10),
  country                     varchar(2) NOT NULL DEFAULT 'IN',

  payment_terms               varchar(100),
  delivery_days               integer,
  minimum_order_amount        numeric(12, 2),

  total_grns                  integer NOT NULL DEFAULT 0,
  average_delivery_days       numeric(5, 2),
  quality_score               integer,
  reliability_score           integer,
  short_shelf_life_incidents  integer NOT NULL DEFAULT 0,
  last_delivery_date          timestamptz,
  total_amount_delivered      numeric(14, 2) NOT NULL DEFAULT 0,

  metadata                    jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_suppliers_tenant
  ON suppliers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_status
  ON suppliers (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_suppliers_name
  ON suppliers (name);
CREATE INDEX IF NOT EXISTS idx_suppliers_city
  ON suppliers (city);
CREATE INDEX IF NOT EXISTS idx_suppliers_gst
  ON suppliers (gst_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_tenant_code_uniq
  ON suppliers (tenant_id, code)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_tenant_gst_uniq
  ON suppliers (tenant_id, gst_number)
  WHERE gst_number IS NOT NULL AND deleted_at IS NULL;

-- ─────────────────── supplier_contacts ───────────────────

CREATE TABLE IF NOT EXISTS supplier_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  supplier_id  uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL,

  name         varchar(100) NOT NULL,
  designation  varchar(100),
  email        varchar(255),
  phone        varchar(20),

  is_primary   boolean NOT NULL DEFAULT false,
  notes        varchar(500)
);

CREATE INDEX IF NOT EXISTS idx_supplier_contacts_supplier
  ON supplier_contacts (supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_contacts_tenant
  ON supplier_contacts (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_contacts_primary_uniq
  ON supplier_contacts (supplier_id)
  WHERE is_primary = true AND deleted_at IS NULL;

-- ─────────────────── supplier_performance ───────────────────

CREATE TABLE IF NOT EXISTS supplier_performance (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  supplier_id              uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  tenant_id                uuid NOT NULL,

  grn_id                   uuid,

  delivery_days            integer NOT NULL DEFAULT 0,
  expiry_remaining_days    integer,
  short_shelf_life         boolean NOT NULL DEFAULT false,
  amount                   numeric(12, 2),

  recorded_at              timestamptz NOT NULL DEFAULT now(),
  metadata                 jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_supplier_performance_supplier
  ON supplier_performance (supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_performance_tenant
  ON supplier_performance (tenant_id);
CREATE INDEX IF NOT EXISTS idx_supplier_performance_grn
  ON supplier_performance (grn_id);
CREATE INDEX IF NOT EXISTS idx_supplier_performance_recorded_at
  ON supplier_performance (recorded_at);

COMMIT;
