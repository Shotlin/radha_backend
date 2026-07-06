-- BE-41 (addendum): Affiliate Engine — webhook signing secret.
--
-- Adds a nullable `hmac_secret` column to `affiliate_partners` so the
-- POST /api/v1/affiliate/revenue webhook endpoint can verify
-- partner-signed payloads without a shared global key. The original
-- BE-41 migration (0013_be41_affiliate.sql) is left untouched.
--
-- A null value means "no webhook configured" — the controller
-- refuses incoming webhooks for those partners with an
-- `AFFILIATE_PARTNER_WEBHOOK_DISABLED` 401.

ALTER TABLE affiliate_partners
  ADD COLUMN IF NOT EXISTS hmac_secret TEXT;
