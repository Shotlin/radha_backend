-- BE-52: RADHA Verified Badge.
-- Per Req 54, Pro tenants whose Operational_Health_Score >= 75 for
-- 30 consecutive days earn a "RADHA Verified" badge. The badge is
-- revoked when OHS drops below 70 for 7 consecutive days. A previously
-- revoked tenant is re-eligible once they recover the 30-day streak.
--
-- One row per tenant (UNIQUE(tenant_id)) keeps the issue/revoke logic
-- idempotent — the cron upserts the row instead of inserting a new
-- one each cycle.

-- Public verify endpoint resolves a tenant via its slug. We add the
-- column here (idempotent) so the slug flow works even if BE-09's
-- main schema was generated before slugs were planned.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS radha_verified_badges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('issued', 'revoked')),
  issued_at       TIMESTAMPTZ NOT NULL,
  last_score      NUMERIC(5, 2),
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS radha_verified_badges_status_idx
  ON radha_verified_badges(status);
