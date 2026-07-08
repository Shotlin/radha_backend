-- 0031_products_global_ean_unique.sql
--
-- ProductLookupService.persistFromOff() (BE-10/BE-11) upserts a global
-- catalog row via `.onConflictDoNothing({ target: products.ean })` whenever
-- a barcode scan misses the local DB and falls back to Open Food Facts.
-- That ON CONFLICT clause requires Postgres to find a real unique
-- constraint/index whose key (and predicate) matches the conflict target —
-- none existed (`products_ean_idx` is a plain, non-unique index), so every
-- live OFF-fallback persist failed with 42P10 ("there is no unique or
-- exclusion constraint matching the ON CONFLICT specification"), silently
-- breaking scan-to-catalog for any barcode not already seeded.
--
-- Global rows are always tenant_id IS NULL by construction (see
-- persistFromOff's insert), and the design intent already documented in
-- products.ts is "global rows have ONE row per EAN" — tenant-private rows
-- may legitimately share an EAN with the global row or with each other
-- across tenants, so the uniqueness is scoped to exactly the global slice,
-- matching the existing partial-index pattern in
-- 0030_browse_catalog_indexes.sql.
--
-- Additive + idempotent (IF NOT EXISTS); no data change. One-way — the DOWN
-- would simply DROP INDEX products_global_ean_unique.

CREATE UNIQUE INDEX IF NOT EXISTS products_global_ean_unique
  ON products (ean)
  WHERE tenant_id IS NULL AND deleted_at IS NULL;
