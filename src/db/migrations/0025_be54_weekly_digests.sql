-- BE-54: Daily Insights Job + Weekly Digest
-- Per Req 47, the scheduler emits a per-Consumer week summary
-- every Sunday at 08:00 IST. The summary is persisted as a row
-- in `consumer_weekly_digests` and fanned out via FCM through
-- the existing notifications service. Re-runs are idempotent on
-- (user_id, week_starting): the cron skips users whose row for
-- the previous Monday already exists.
--
-- `delivered_at` is set after a successful FCM send. When the
-- send fails, the row is left with `delivered_at IS NULL` so a
-- redelivery sweep can pick it up. The partial index below makes
-- that retry path cheap.

CREATE TABLE IF NOT EXISTS consumer_weekly_digests (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_starting            DATE NOT NULL,
  scans_count              INT NOT NULL,
  high_sugar_count         INT NOT NULL,
  recall_count             INT NOT NULL,
  alternatives_recommended INT NOT NULL,
  payload                  JSONB NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at             TIMESTAMPTZ,
  CONSTRAINT consumer_weekly_digests_user_week_unique
    UNIQUE (user_id, week_starting)
);

-- Hot path for the redelivery sweep: undelivered rows ordered by
-- the week they cover.
CREATE INDEX IF NOT EXISTS idx_consumer_weekly_digests_undelivered
  ON consumer_weekly_digests(week_starting)
  WHERE delivered_at IS NULL;
