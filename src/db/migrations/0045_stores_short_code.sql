-- 0045_stores_short_code.sql
--
-- Short, globally-unique, human-shareable store identifier shown in the
-- app in place of the raw `id` UUID (Profile screen's "Store ID"). Nullable
-- so existing rows can be backfilled by a follow-up script; every
-- store-creation path generates one going forward. NULLs don't collide
-- under a unique index in Postgres, so this is safe pre-backfill.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS short_code varchar(12);
CREATE UNIQUE INDEX IF NOT EXISTS stores_short_code_unique ON stores (short_code);
