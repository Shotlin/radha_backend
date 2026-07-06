-- BE-56: Community Barcode Learning Service
-- Per Req 46, lets consumers submit India-specific products that
-- aren't in Open Food Facts and lets others flag a product they
-- think is wrong. Three unique flags push the entry back into the
-- moderator queue (`status = 'flagged'`).
--
-- The feature is intentionally tenant-less: approved entries land
-- in the global `Product_Catalog` (tenant_id = NULL) and are
-- visible to every consumer.

CREATE TABLE IF NOT EXISTS barcode_learning_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_user_id UUID NOT NULL REFERENCES users(id),
  ean               TEXT NOT NULL,
  brand             TEXT,
  name              TEXT,
  category          TEXT,
  s3_object_keys    TEXT[],
  status            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','flagged')),
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  moderated_at      TIMESTAMPTZ,
  moderated_by      UUID REFERENCES users(id),
  moderation_notes  TEXT
);

CREATE INDEX IF NOT EXISTS idx_barcode_submissions_status
  ON barcode_learning_submissions(status, submitted_at);

CREATE INDEX IF NOT EXISTS idx_barcode_submissions_ean
  ON barcode_learning_submissions(ean);

CREATE TABLE IF NOT EXISTS barcode_learning_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_ean     TEXT NOT NULL,
  flagger_user_id UUID NOT NULL REFERENCES users(id),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product_ean, flagger_user_id)
);

CREATE INDEX IF NOT EXISTS idx_barcode_flags_ean
  ON barcode_learning_flags(product_ean);
