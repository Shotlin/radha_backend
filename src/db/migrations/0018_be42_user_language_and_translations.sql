-- BE-42 — Multi-language i18n persistence.
--
-- Two changes:
--   1. `users.preferred_language` is the authenticated user's chosen
--      language. The Drizzle schema (`server/src/db/schema/users.ts`)
--      already declares the column with `NOT NULL DEFAULT 'en'`; an
--      earlier migration to add it is missing from the repo, so this
--      file does the additive ALTER defensively. The CHECK constraint
--      is added in a separate idempotent block so re-runs are safe.
--
--   2. `product_translations` stores per-language overrides for product
--      fields. `ean` is plain TEXT (no FK to products) — see BE-42 brief
--      §"Schema migration" — because incoming OFF data isn't guaranteed
--      to satisfy a unique constraint on `products.ean` yet.
--
-- Idempotent: every CREATE / ALTER guards itself with IF NOT EXISTS or
-- DO blocks, so re-running the migration is safe.

-- ───── users.preferred_language ─────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'en';

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_preferred_language_check
    CHECK (preferred_language IN ('en','hi','ta','te','bn','mr'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table  THEN NULL;
  -- pg <13 reports the failed-add as "constraint already exists" via
  -- a generic "syntax_error_or_access_rule_violation" — the IF NOT
  -- EXISTS form below covers the common case explicitly.
END $$;

-- ───── product_translations ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_translations (
  ean              TEXT NOT NULL,
  language         TEXT NOT NULL,
  name             TEXT,
  brand            TEXT,
  ingredients_text TEXT,
  pros             TEXT[],
  cons             TEXT[],
  PRIMARY KEY (ean, language),
  CONSTRAINT product_translations_language_check
    CHECK (language IN ('en','hi','ta','te','bn','mr'))
);

CREATE INDEX IF NOT EXISTS product_translations_language_idx
  ON product_translations (language);

CREATE INDEX IF NOT EXISTS product_translations_ean_idx
  ON product_translations (ean);
