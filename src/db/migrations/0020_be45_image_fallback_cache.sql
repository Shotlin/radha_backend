-- BE-45: Image OCR Scan Fallback Cache
-- Adds `image_fallback_cache` — per-image dedupe row keyed by
-- `image_sha256`. When two concurrent Mobile_App callers upload the
-- same packaging photo (same hash), only the first one burns Vision
-- quota; everyone else reuses the cached match. Negative-cache rows
-- (`matched = false`) keep us from re-running Vision on images that
-- already failed identification.
--
-- Tenant-agnostic by design: image fallback identifies a product,
-- not tenant inventory, and Cloud Vision's answer is universal.
-- Caching tenant-by-tenant would multiply Req 38's cost ceiling by N.

CREATE TABLE IF NOT EXISTS image_fallback_cache (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  image_sha256        TEXT NOT NULL UNIQUE,
  s3_object_key       TEXT NOT NULL,

  ean                 TEXT,
  product_name        TEXT,
  brand               TEXT,

  source              TEXT NOT NULL DEFAULT 'none',
  matched             BOOLEAN NOT NULL DEFAULT false,
  matched_at          TIMESTAMPTZ,

  vision_cost_paise   INTEGER NOT NULL DEFAULT 0,
  generated_by        TEXT,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS image_fallback_cache_sha256_idx
  ON image_fallback_cache (image_sha256);

CREATE INDEX IF NOT EXISTS image_fallback_cache_s3_key_idx
  ON image_fallback_cache (s3_object_key);

CREATE INDEX IF NOT EXISTS image_fallback_cache_source_idx
  ON image_fallback_cache (source);
