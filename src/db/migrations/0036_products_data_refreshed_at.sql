-- 0036_products_data_refreshed_at.sql
--
-- Fixes the sticky-wrong-product-data bug: ProductLookupService's
-- persistFromOff/persistFromProvider used `.onConflictDoNothing()` on the
-- global-catalog upsert, so the FIRST external-provider hit for an EAN was
-- persisted forever and never refreshed -- a stale or wrong initial read
-- (or one provider disagreeing with a better one) stuck permanently.
--
-- This column backs the fix: `onConflictDoUpdate` now only overwrites when
-- the existing row is unrefreshed or older than 30 days (or a `forceRefresh`
-- lookup explicitly asks), gated by this timestamp.
--
-- Additive + idempotent (IF NOT EXISTS); no data change; nullable so
-- existing rows are simply "never refreshed" until next touched.

ALTER TABLE products ADD COLUMN IF NOT EXISTS data_refreshed_at timestamptz;
