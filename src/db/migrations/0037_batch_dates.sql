-- BE-58: Batch-aware crowd-sourced expiry (Feature B).
--
-- `batch_date_observations` is an append-only vote log (one row per user
-- per (ean, batch, expiry) reading -- the unique index makes a repeat
-- vote a no-op, never a duplicate). `product_batch_consensus` is the
-- precomputed read model `consensus.ts` maintains inside the same
-- transaction as every new observation; GET endpoints only ever read
-- this table, never recompute on the fly.
--
-- Both tables are intentionally tenant-less (like barcode_learning): a
-- batch's real-world expiry date is a fact about the physical product,
-- not about which tenant scanned it.

DO $$ BEGIN
  CREATE TYPE batch_date_observation_source AS ENUM (
    'user_scan', 'manual', 'backfill_scan_items', 'backfill_expiry_records'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE product_batch_consensus_status AS ENUM ('candidate', 'trusted', 'disputed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS batch_date_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ean VARCHAR(14) NOT NULL,
  batch_code VARCHAR(64) NOT NULL,
  mfg_date DATE,
  expiry_date DATE NOT NULL,
  user_id UUID NOT NULL,
  source batch_date_observation_source NOT NULL,
  extractor_confidence NUMERIC(3, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS batch_obs_ean_batch_idx ON batch_date_observations (ean, batch_code);

-- One vote per user per (ean, batch, expiry) -- a user correcting their
-- own earlier read (different expiry) is a new vote, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS batch_obs_dedupe
  ON batch_date_observations (user_id, ean, batch_code, expiry_date);

CREATE TABLE IF NOT EXISTS product_batch_consensus (
  ean VARCHAR(14) NOT NULL,
  batch_code VARCHAR(64) NOT NULL,
  consensus_expiry DATE,
  consensus_mfg DATE,
  confirmations INT NOT NULL,
  distinct_users INT NOT NULL,
  confidence NUMERIC(3, 2) NOT NULL,
  status product_batch_consensus_status NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ean, batch_code)
);
