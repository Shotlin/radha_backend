-- 0042_ai_operation_date_photo_analysis.sql
--
-- Adds 'date-photo-analysis' to the ai_operation enum so the new
-- expiry/mfg-date-only vision escalation endpoint
-- (POST /api/v1/ai/date/analyze-photo, src/integrations/ai/services/
-- ai-orchestrator.service.ts) can record usage/quota (ai_usage_log.operation)
-- and audit entries (ai_extractions.operation) under its own operation key,
-- separate from 'label-photo-analysis' (the full nutrition-panel photo
-- flow) so the expiry-record wizard's frequent, routine date scans can't
-- exhaust the much rarer product-onboarding photo-analysis quota.
--
-- DOWN reversal: PostgreSQL cannot DROP a value from an enum. Reversal
-- would require recreating the ai_operation type without this value and
-- rewriting all dependent columns. This is intentionally one-way and
-- additive (safe -- no existing rows are affected).

ALTER TYPE ai_operation ADD VALUE IF NOT EXISTS 'date-photo-analysis' AFTER 'label-photo-analysis';
