-- BE-50: Webhooks for Pro Tier
-- Per Req 52, Pro tenants register up to 5 outbound webhook endpoints.
-- Each endpoint subscribes to a list of event names and receives an
-- HMAC-SHA256 signed POST whenever a matching event fires server-side.
--
-- `webhook_deliveries` captures every fan-out attempt:
--   - status `'pending'` until first attempt completes,
--   - `'succeeded'` when receiver returns 2xx within 10s,
--   - `'failed'` after a non-2xx / timeout — retried with exponential
--     backoff (1m, 5m, 15m, 30m, 60m) up to 5 attempts total.
-- Rows expire after 7 days; the BE-31 cleanup sweep prunes old rows.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  events      TEXT[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant
  ON webhook_endpoints(tenant_id)
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id       UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_name        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts          INT NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ,
  last_error        TEXT,
  last_status_code  INT,
  next_retry_at     TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retry sweeper hot path: pending/failed deliveries that haven't blown
-- the 5-attempt cap and are due for another try.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
  ON webhook_deliveries(next_retry_at)
  WHERE status IN ('pending', 'failed') AND attempts < 5;
