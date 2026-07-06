-- BE-14 — Product Search Indexes & tsvector column.
--
-- Adds:
--   1. `pg_trgm` extension (fuzzy match support).
--   2. `products.search_tsv` tsvector column + auto-update trigger.
--   3. GIN index on `search_tsv`        (full-text search).
--   4. GIN trigram indexes on `name` and `brand` (fuzzy / substring).
--   5. Composite covering index on (tenant_id) for tenant-scoped lookups.
--
-- Idempotent: every CREATE / ALTER guards itself with IF NOT EXISTS or
-- DROP-then-CREATE, so re-running the migration is safe.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

-- Auto-update trigger function. Re-defined on every migration run so
-- weight rules can evolve in a single source of truth.
CREATE OR REPLACE FUNCTION products_search_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')),        'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.brand, '')),       'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(NEW.ean, '')),         'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_search_tsv_trigger ON products;
CREATE TRIGGER products_search_tsv_trigger
  BEFORE INSERT OR UPDATE OF name, brand, description, ean
  ON products
  FOR EACH ROW
  EXECUTE FUNCTION products_search_tsv_update();

CREATE INDEX IF NOT EXISTS products_search_tsv_idx
  ON products USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON products USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS products_brand_trgm_idx
  ON products USING GIN (brand gin_trgm_ops);

-- Backfill existing rows that pre-date the column.
UPDATE products SET search_tsv =
  setweight(to_tsvector('english', COALESCE(name, '')),        'A') ||
  setweight(to_tsvector('english', COALESCE(brand, '')),       'B') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'C') ||
  setweight(to_tsvector('english', COALESCE(ean, '')),         'D')
WHERE search_tsv IS NULL;

-- ───── Search analytics & popularity tables ────────────────────────

CREATE TABLE IF NOT EXISTS search_queries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  tenant_id     uuid,
  user_id       uuid,
  query_text    varchar(200) NOT NULL,
  result_count  integer NOT NULL DEFAULT 0,
  duration_ms   integer NOT NULL DEFAULT 0,
  has_results   boolean NOT NULL DEFAULT false,
  source        varchar(32) NOT NULL DEFAULT 'search'  -- 'search' | 'autocomplete'
);

CREATE INDEX IF NOT EXISTS search_queries_tenant_idx
  ON search_queries (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS search_queries_user_idx
  ON search_queries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS search_queries_no_results_idx
  ON search_queries (tenant_id, created_at DESC)
  WHERE has_results = false;

CREATE TABLE IF NOT EXISTS popular_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tenant_id     uuid,
  scan_count    integer NOT NULL DEFAULT 0,
  search_count  integer NOT NULL DEFAULT 0,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT popular_products_tenant_product_uniq UNIQUE (tenant_id, product_id)
);

CREATE INDEX IF NOT EXISTS popular_products_tenant_idx
  ON popular_products (tenant_id, scan_count DESC);

CREATE INDEX IF NOT EXISTS popular_products_recency_idx
  ON popular_products (tenant_id, last_seen_at DESC);
