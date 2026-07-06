-- BE-22 — AI/OCR Wrapper persistence layer.
--
-- Three tables, two enums:
--   1. `ai_operation` enum (9 ops, matches AiOperation union)
--   2. `ai_provider`  enum (7 providers, matches AiProvider union)
--   3. `ai_extractions`        — per-call audit (tenant scoped)
--   4. `ai_usage_log`          — append-only quota / cost ledger
--   5. `ai_explanation_cache`  — permanent cache for deterministic
--                                LLM outputs (Req 45). Global by design.
--
-- Idempotent: every CREATE / ALTER guards itself with IF NOT EXISTS or
-- DO blocks, so re-running the migration is safe.

-- ───── Enums ──────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE ai_operation AS ENUM (
    'ocr-expiry',
    'ocr-batch',
    'ocr-text',
    'label-analysis',
    'image-fallback',
    'report-summary',
    'product-enrichment',
    'image-classification',
    'ingredient-explanation'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ai_provider AS ENUM (
    'mlkit',
    'rekognition',
    'google-vision',
    'openai',
    'claude',
    'openfoodfacts',
    'mock'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ───── ai_extractions ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_extractions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  tenant_id       uuid NOT NULL,

  operation       ai_operation NOT NULL,
  provider        ai_provider NOT NULL,

  source_type     varchar(32),
  source_id       uuid,

  success         varchar(8) NOT NULL DEFAULT 'false',

  extracted_text  varchar(5000),
  extracted_data  jsonb DEFAULT '{}'::jsonb,
  confidence      numeric(4, 3),

  duration_ms     integer NOT NULL DEFAULT 0,
  cost            numeric(10, 6) NOT NULL DEFAULT 0,
  tokens_used     integer,

  user_id         uuid,
  request_id      varchar(64),

  metadata        jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ai_extractions_tenant_op_idx
  ON ai_extractions (tenant_id, operation);
CREATE INDEX IF NOT EXISTS ai_extractions_source_idx
  ON ai_extractions (source_type, source_id);
CREATE INDEX IF NOT EXISTS ai_extractions_provider_idx
  ON ai_extractions (provider);
CREATE INDEX IF NOT EXISTS ai_extractions_created_at_idx
  ON ai_extractions (created_at);

-- ───── ai_usage_log ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  tenant_id       uuid NOT NULL,
  user_id         uuid,

  operation       ai_operation NOT NULL,
  provider        ai_provider NOT NULL,

  cost            numeric(10, 6) NOT NULL DEFAULT 0,
  duration_ms     integer NOT NULL DEFAULT 0,
  tokens_used     integer NOT NULL DEFAULT 0,

  success         varchar(8) NOT NULL DEFAULT 'true',

  year_month      varchar(7) NOT NULL,
  year_month_day  varchar(10) NOT NULL,

  resource_id     uuid,
  metadata        jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ai_usage_tenant_month_op_idx
  ON ai_usage_log (tenant_id, year_month, operation);
CREATE INDEX IF NOT EXISTS ai_usage_tenant_day_idx
  ON ai_usage_log (tenant_id, year_month_day);
CREATE INDEX IF NOT EXISTS ai_usage_provider_idx
  ON ai_usage_log (provider);

-- ───── ai_explanation_cache ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_explanation_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  operation       ai_operation NOT NULL,
  cache_key       varchar(255) NOT NULL,
  locale          varchar(16) NOT NULL DEFAULT 'en',
  rule_version    varchar(32) NOT NULL DEFAULT '1.0.0',

  response        jsonb NOT NULL,
  response_text   varchar(8000),

  provider        ai_provider NOT NULL,
  cost            numeric(10, 6) NOT NULL DEFAULT 0,
  tokens_used     integer NOT NULL DEFAULT 0,

  hit_count       integer NOT NULL DEFAULT 0,
  last_hit_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_explanation_cache_key_uniq
  ON ai_explanation_cache (operation, cache_key, locale, rule_version);

CREATE INDEX IF NOT EXISTS ai_explanation_cache_operation_idx
  ON ai_explanation_cache (operation);
