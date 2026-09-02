-- 0046_stores_gstin_business_hours.sql
--
-- Store Details screen (Profile > Store details): GSTIN (optional
-- compliance field) and per-day business hours, editable by the store
-- owner. Both nullable -- existing stores have neither set until the
-- owner fills them in via the edit screen.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS gstin varchar(15);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS business_hours jsonb;
