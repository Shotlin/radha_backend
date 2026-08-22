import type { AiOperation, OperationLimits } from './types/ai.types';

/**
 * BE-22 — AI/OCR wrapper constants.
 *
 * All knobs (limits, costs, timeouts, circuit-breaker thresholds) live
 * here so BE-32 (perf tuning) and BE-46 (rate limiter v2) can iterate
 * in one place.
 */

/** Hard wall-clock cap on a single LLM completion (Req 45 + T-v2.3). */
export const AI_LLM_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Wall-clock cap specifically for text-to-speech (fish-audio/s2.1-pro-
 * free:free via OpenRouter). Longer than AI_LLM_DEFAULT_TIMEOUT_MS
 * because synthesizing a full multi-paragraph AI insight into speech
 * takes meaningfully longer than a short chat completion, and because
 * the free tier explicitly carries no latency guarantee (OpenRouter's
 * own model page) — a real call for the app's full insight text (~1700
 * chars) measured >10s and hit the old shared default (2026-08-22).
 * The app's own HTTP client timeout is 30s (dio_provider.dart), so this
 * stays safely under that with headroom for network overhead.
 */
export const AI_TTS_TIMEOUT_MS = 25_000;

/**
 * Transient-failure retry policy for LLM providers. A production LLM call can
 * hit a transient 429/5xx or a dropped connection; one retry with jittered
 * exponential backoff absorbs those without compounding latency. Per-attempt
 * timeouts (`timeoutMs`) still bound each try, and a wall-clock timeout
 * (AbortError) is treated as terminal — retrying it would blow the budget.
 */
export const AI_LLM_MAX_ATTEMPTS = 3;
export const AI_LLM_RETRY_BASE_DELAY_MS = 250;
/** HTTP statuses worth retrying (rate-limit + transient upstream errors). */
export const AI_LLM_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Wall-clock cap on a single Vision / Rekognition request. */
export const AI_VISION_DEFAULT_TIMEOUT_MS = 8_000;

/** Confidence threshold under which an OCR result triggers a "verify manually" warning. */
export const AI_OCR_LOW_CONFIDENCE = 0.7;

/** Max chars persisted to `ai_extractions.extracted_text`. */
export const AI_EXTRACTED_TEXT_MAX = 5_000;

/** Max chars persisted to `ai_explanation_cache.response_text`. */
export const AI_EXPLANATION_TEXT_MAX = 8_000;

/** Default ingredient-explainer rule version. Bump to invalidate cache. */
export const AI_EXPLANATION_RULE_VERSION = '1.0.0';

/** Per-call $ cost projections used by `getEstimatedCost`. */
export const AI_OPERATION_UNIT_COST: Record<AiOperation, number> = {
  'ocr-expiry': 0,
  'ocr-batch': 0,
  'ocr-text': 0,
  'label-analysis': 0.001,
  // Placeholder estimate for a Gemini Flash vision call (inline image +
  // ~300-token prompt, ~500-800 output tokens) — confirm against actual
  // Gemini pricing before assuming this is exact. Currently configured to
  // run on Gemini's FREE tier (see AI_DEFAULT_LIMITS below), so this cost
  // figure is for future paid-tier reference only, not a live spend today.
  'label-photo-analysis': 0.003,
  // gpt-4o-mini via OpenRouter: ~1700 input tokens (image + short prompt)
  // + ~100 output tokens (a 3-field JSON object) at $0.15/$0.60 per M
  // tokens ≈ $0.0003/call. Rounded up for headroom.
  'date-photo-analysis': 0.0005,
  // fish-audio/s2.1-pro-free:free via OpenRouter — genuinely $0, not an
  // estimate (see ai.module.ts / OPENROUTER_TTS_MODEL default).
  'text-to-speech': 0,
  'image-fallback': 0.0015,
  'report-summary': 0.005,
  'product-enrichment': 0.003,
  'image-classification': 0.001,
  'ingredient-explanation': 0.002,
};

/**
 * Default monthly / daily quotas per operation.
 *
 * `ocr-*` operations are free (mobile ML Kit) but capped to deter
 * abuse. Paid operations (Rekognition, Vision, OpenAI) carry tighter
 * caps; tenants can override these via the BE-31 dashboard once
 * subscription tiers ship.
 */
export const AI_DEFAULT_LIMITS: Record<AiOperation, OperationLimits> = {
  'ocr-expiry': { monthly: 10_000, daily: 1_000 },
  'ocr-batch': { monthly: 10_000, daily: 1_000 },
  'ocr-text': { monthly: 10_000, daily: 1_000 },
  'label-analysis': { monthly: 100, daily: 20 },
  // Per-tenant cap for the new photo->structured-JSON path. Deliberately
  // conservative: Gemini's FREE tier (Google AI Studio key, no billing) is
  // a GLOBAL ceiling shared by the whole backend's single API key — roughly
  // 1,500 requests/day, 10-15/minute (2026 published limits) — not a
  // per-tenant allowance. This per-tenant cap keeps a few simultaneously
  // active tenants safely under that shared ceiling. Raise only after
  // confirming actual multi-tenant concurrent usage, and/or upgrading to a
  // paid Gemini tier (trivially cheap — see AI_OPERATION_UNIT_COST above).
  'label-photo-analysis': { monthly: 300, daily: 50 },
  // Deliberately generous relative to label-photo-analysis — this is a
  // per-scan fallback for a routine, frequent action (adding an expiry
  // record), not an occasional product-onboarding step, and the per-call
  // cost is roughly 1/6th of label-photo-analysis's.
  'date-photo-analysis': { monthly: 2_000, daily: 200 },
  // The free TTS endpoint has its own OpenRouter-side rate limit already
  // (see fish-audio/s2.1-pro-free:free docs) — this cap just deters
  // in-app abuse, not cost (the model is free).
  'text-to-speech': { monthly: 3_000, daily: 300 },
  'image-fallback': { monthly: 200, daily: 30 },
  'report-summary': { monthly: 100, daily: 20 },
  'product-enrichment': { monthly: 500, daily: 50 },
  'image-classification': { monthly: 500, daily: 50 },
  'ingredient-explanation': { monthly: 1_000, daily: 100 },
};

/** Circuit-breaker tuning for paid providers. */
export const AI_CB_FAILURE_THRESHOLD = 5;
export const AI_CB_SUCCESS_THRESHOLD = 2;
export const AI_CB_OPEN_DURATION_MS = 60_000;

/** Reserved system tenant id used when an extraction has no auth context. */
export const AI_SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
