-- 0038_ai_operation_label_photo_analysis.sql
--
-- Adds 'label-photo-analysis' to the ai_operation enum so the new
-- vision-native photo->structured-JSON label analysis endpoint
-- (POST /api/v1/ai/label/analyze-photo, src/integrations/ai/services/
-- ai-orchestrator.service.ts) can record usage/quota (ai_usage_log.operation)
-- and audit entries (ai_extractions.operation) under its own operation key,
-- separate from the existing 'label-analysis' bucket shared by
-- /label/analyze and /label/analyze-text.
--
-- DOWN reversal: PostgreSQL cannot DROP a value from an enum. Reversal
-- would require recreating the ai_operation type without this value and
-- rewriting all dependent columns. This is intentionally one-way and
-- additive (safe -- no existing rows are affected).

ALTER TYPE ai_operation ADD VALUE IF NOT EXISTS 'label-photo-analysis' AFTER 'label-analysis';
