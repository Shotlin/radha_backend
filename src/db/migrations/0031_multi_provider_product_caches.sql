-- Multi-source product lookup: Open Beauty Facts + Open Products Facts caches
-- Adds two new global (non-tenant-scoped) caches alongside the existing
-- open_food_facts_cache, structurally identical to it. Lets the product
-- lookup orchestrator fall through Open Food Facts -> Open Beauty Facts
-- (cosmetics/personal care) -> Open Products Facts (household/general
-- merchandise) -> UPCitemdb (no DB cache needed, free tier too small to
-- benefit from one) before giving up on a barcode scan.
--
-- `products.data_source` / `product_nutrition.data_source` need no schema
-- change — both are already plain varchar(50), not a constrained enum.

CREATE TABLE IF NOT EXISTS open_beauty_facts_cache (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ean                VARCHAR(13) NOT NULL,
  raw_data           JSONB,
  product_name       VARCHAR(200),
  brand              VARCHAR(100),
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  hit_count          INTEGER NOT NULL DEFAULT 0,
  last_accessed_at   TIMESTAMPTZ DEFAULT NOW(),
  api_version        VARCHAR(10) NOT NULL DEFAULT 'v2',
  fetch_success      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS obf_cache_ean_unique ON open_beauty_facts_cache(ean);
CREATE INDEX IF NOT EXISTS obf_cache_expires_idx ON open_beauty_facts_cache(expires_at);
CREATE INDEX IF NOT EXISTS obf_cache_accessed_idx ON open_beauty_facts_cache(last_accessed_at);

CREATE TABLE IF NOT EXISTS open_products_facts_cache (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ean                VARCHAR(13) NOT NULL,
  raw_data           JSONB,
  product_name       VARCHAR(200),
  brand              VARCHAR(100),
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  hit_count          INTEGER NOT NULL DEFAULT 0,
  last_accessed_at   TIMESTAMPTZ DEFAULT NOW(),
  api_version        VARCHAR(10) NOT NULL DEFAULT 'v2',
  fetch_success      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS opf_cache_ean_unique ON open_products_facts_cache(ean);
CREATE INDEX IF NOT EXISTS opf_cache_expires_idx ON open_products_facts_cache(expires_at);
CREATE INDEX IF NOT EXISTS opf_cache_accessed_idx ON open_products_facts_cache(last_accessed_at);
