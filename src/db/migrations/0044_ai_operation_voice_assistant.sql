-- 0044_ai_operation_voice_assistant.sql
--
-- Adds 'voice-assistant' to the ai_operation enum so the new mic/voice
-- Q&A endpoint (POST /api/v1/voice/assistant/turn, src/modules/voice/)
-- can record usage/quota (ai_usage_log.operation) under its own operation
-- key, separate from every other AI feature.
--
-- DOWN reversal: PostgreSQL cannot DROP a value from an enum. Reversal
-- would require recreating the ai_operation type without this value and
-- rewriting all dependent columns. This is intentionally one-way and
-- additive (safe -- no existing rows are affected).

ALTER TYPE ai_operation ADD VALUE IF NOT EXISTS 'voice-assistant' AFTER 'text-to-speech';
