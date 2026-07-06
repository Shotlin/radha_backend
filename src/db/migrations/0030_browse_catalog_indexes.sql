-- 0030_browse_catalog_indexes.sql
--
-- Supporting index for the consumer catalog browse surface
-- (GET /api/v1/catalog/products — ConsumerCatalogController). That query reads
-- ONLY the global catalog (tenant_id IS NULL, status = 'active', not
-- soft-deleted), optionally filtered by category_id, joined to the latest
-- health assessment and sorted by score.
--
-- A partial index over exactly those rows keeps the "Browse <category>" filter
-- index-driven while staying tiny (it excludes every tenant-private and
-- inactive row the consumer surface never reads). Leading with category_id
-- serves the common category-filtered browse; the global/active/not-deleted
-- predicate is baked into the partial WHERE.
--
-- Additive + idempotent (IF NOT EXISTS); no data change. One-way — the DOWN
-- would simply DROP INDEX products_global_catalog_idx.

CREATE INDEX IF NOT EXISTS products_global_catalog_idx
  ON products (category_id)
  WHERE tenant_id IS NULL AND deleted_at IS NULL AND status = 'active';
