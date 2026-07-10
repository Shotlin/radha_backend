-- 0039_expiry_reminder_sent.sql
--
-- Dedupe table for the expiry-reminders cron (Phase 10 / BE-B4).
--
-- One row per (user, expiry_record, window) combination guarantees the
-- 03:00 UTC cron never double-sends a notification even if it re-runs
-- in the same calendar day (recovery restart, etc.).
--
-- `reminder_window` holds the days-remaining bucket: 7, 2, or 0.
-- (Named reminder_window, not window, because window is a Postgres reserved word.)
-- No tenant_id column: the expiry record's tenant is resolved at send
-- time via expiry_records.tenant_id — duplicating it here adds no query
-- value and creates a denorm risk.

CREATE TABLE IF NOT EXISTS expiry_reminder_sent (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL,
  expiry_record_id uuid        NOT NULL,
  reminder_window  smallint    NOT NULL,     -- 7 | 2 | 0 days
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expiry_reminder_sent_uniq
    UNIQUE (user_id, expiry_record_id, reminder_window)
);

CREATE INDEX IF NOT EXISTS expiry_reminder_record_idx
  ON expiry_reminder_sent (expiry_record_id);
