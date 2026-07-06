-- 0029_be22v2_ai_provider_gemini.sql
--
-- Adds 'gemini' to the ai_provider enum so the new Google Gemini LLM
-- provider (src/integrations/ai/providers/gemini-llm.provider.ts) can be
-- persisted in ai_extractions.provider, ai_usage.provider, and
-- ai_explanation_cache.provider.
--
-- DOWN reversal: PostgreSQL cannot DROP a value from an enum. Reversal
-- would require recreating the ai_provider type without 'gemini' and
-- rewriting all dependent columns. This is intentionally one-way and
-- additive (safe — no existing rows are affected).

ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'gemini' AFTER 'openai';
