-- BE-53: Admin Impersonation Tool
-- Per Req 51, RADHA support staff can open a time-limited "view as user"
-- session against a tenant user. Each session lives at most 60 minutes,
-- always carries a reason, blocks destructive actions, and writes a
-- per-request audit row to `impersonation_actions`.
--
-- Two tables:
--   - impersonation_sessions: one row per opened session. JWT minted at
--     start carries `sessionId` matching this row's id; expiry matches
--     `expires_at`. Soft-end via `ended_at` keeps history intact.
--   - impersonation_actions: per-request ledger written by
--     ImpersonationActionLoggerMiddleware. Captures method, path, and
--     final response status only — never payload, so no PII leaks.

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id         UUID NOT NULL REFERENCES users(id),
  impersonated_user_id  UUID NOT NULL REFERENCES users(id),
  reason                TEXT NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 minutes'),
  ended_at              TIMESTAMPTZ,
  ended_reason          TEXT,
  CONSTRAINT impersonation_reason_min CHECK (length(reason) >= 10)
);

-- Hot path: list active sessions owned by a given staff user (cap
-- enforcement, "end my current session" lookup).
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_staff_active
  ON impersonation_sessions(staff_user_id)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS impersonation_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES impersonation_sessions(id) ON DELETE CASCADE,
  request_path    TEXT NOT NULL,
  request_method  TEXT NOT NULL,
  response_status INT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit replay: every action for a session in chronological order.
CREATE INDEX IF NOT EXISTS idx_impersonation_actions_session
  ON impersonation_actions(session_id, occurred_at);
