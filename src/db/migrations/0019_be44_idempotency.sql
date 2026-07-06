-- BE-44: Offline-First Sync + Idempotency
-- Adds `idempotency_records` so mutating endpoints (POST/PUT/PATCH/DELETE)
-- carrying an `Idempotency-Key` header can replay the original response
-- instead of executing the mutation twice. Rows live for 24h by default;
-- the BE-31 cleanup sweep removes anything past `expires_at`.

CREATE TABLE IF NOT EXISTS idempotency_records (
  key TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idem_expires
  ON idempotency_records (expires_at);
