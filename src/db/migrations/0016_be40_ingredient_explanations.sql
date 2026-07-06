-- BE-40: AI Ingredient Explainer (LLM)
-- Adds `ingredient_explanations` — permanent cache for plain-language
-- LLM-generated explanations keyed by (ingredient_slug, language).
-- Tenant-agnostic: explanations are universal and shared across every
-- tenant. The first request per (slug, language) burns LLM budget;
-- every subsequent request returns the cached row in <50ms.

CREATE TABLE IF NOT EXISTS ingredient_explanations (
  ingredient_slug TEXT NOT NULL,
  description TEXT NOT NULL,
  health_considerations TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  language TEXT NOT NULL DEFAULT 'en',
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ingredient_slug, language)
);

CREATE INDEX IF NOT EXISTS ingredient_explanations_slug_idx
  ON ingredient_explanations (ingredient_slug);
