-- 0043_ai_operation_text_to_speech.sql
--
-- Adds 'text-to-speech' to the ai_operation enum so the new cloud-voice
-- upgrade endpoint (POST /api/v1/ai/speech, src/integrations/ai/services/
-- ai-orchestrator.service.ts) can record usage/quota (ai_usage_log.operation)
-- under its own operation key. The model itself (fish-audio/s2.1-pro-free:free
-- via OpenRouter) is free — this cap deters in-app abuse, not cost.
--
-- DOWN reversal: PostgreSQL cannot DROP a value from an enum. Reversal
-- would require recreating the ai_operation type without this value and
-- rewriting all dependent columns. This is intentionally one-way and
-- additive (safe -- no existing rows are affected).

ALTER TYPE ai_operation ADD VALUE IF NOT EXISTS 'text-to-speech' AFTER 'date-photo-analysis';
