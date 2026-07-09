import { Injectable, Logger } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import {
  AI_LLM_DEFAULT_TIMEOUT_MS,
  AI_LLM_MAX_ATTEMPTS,
  AI_LLM_RETRY_BASE_DELAY_MS,
  AI_LLM_RETRYABLE_STATUSES,
  AI_OPERATION_UNIT_COST,
} from '../ai.constants';
import type { AiOperation, AiProvider, ILlmProvider, LlmOptions, LlmResult } from '../types/ai.types';

/**
 * Google Gemini LLM provider (Generative Language API, v1beta).
 *
 * Backs the same `ILlmProvider` contract as `OpenAiLlmProvider` so the
 * ingredient explainer (Req 45), label-transcript analysis, and
 * report-summary generation (`FEATURE_LLM_SUMMARIES`) can run on Gemini. Uses
 * the REST endpoint via the global `fetch` (no SDK dependency) — mirrors the
 * MSG91 / Open Food Facts integration style.
 *
 * Production hardening (T-v2.x):
 *   - **Auth via header.** The API key travels in the `x-goog-api-key` header,
 *     never the URL query string, so it can't leak into request logs or
 *     error messages that echo the endpoint.
 *   - **Structured output.** When `options.json` is set the request constrains
 *     the model to a single JSON object (`responseMimeType: application/json`),
 *     removing the markdown-fence / prose-leak fragility of prompt-only JSON.
 *   - **Model routing.** `options.model` overrides the env default per call so
 *     callers can escalate a harder task to a heavier model.
 *   - **Retry with backoff.** Transient 429/5xx and dropped connections are
 *     retried with jittered exponential backoff (bounded by
 *     `AI_LLM_MAX_ATTEMPTS`); a wall-clock timeout is terminal so retries never
 *     exceed the caller's budget.
 *
 * Configuration (read from `process.env` directly, matching the
 * `OpenAiLlmProvider` decision not to expand the shared typed env schema for
 * optional AI keys):
 *   - `GEMINI_API_KEY` — required to activate the provider.
 *   - `GEMINI_MODEL`   — optional, defaults to `gemini-2.5-flash`.
 */
@Injectable()
export class GeminiLlmProvider implements ILlmProvider {
  readonly name: AiProvider = 'gemini';
  private readonly logger = new Logger(GeminiLlmProvider.name);
  private static readonly BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    if (this.config.isTest) return false;
    return Boolean(process.env.GEMINI_API_KEY);
  }

  async complete(prompt: string, options: LlmOptions = {}): Promise<LlmResult> {
    const apiKey = this.requireApiKey();
    const { timeoutMs, model, generationConfig } = this.buildGenerationParams(options);
    const url = `${GeminiLlmProvider.BASE_URL}/${encodeURIComponent(model)}:generateContent`;
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    };
    return this.sendWithRetry(url, apiKey, JSON.stringify(requestBody), timeoutMs, 'complete');
  }

  /**
   * Multimodal completion — a prompt plus one inline image, for
   * photo→structured-JSON extraction (e.g. reading a nutrition label
   * directly from a photo rather than from OCR-flattened text). Gemini's
   * `generateContent` accepts an image as an additional `parts` entry
   * alongside the text prompt in the same request — this is a documented,
   * stable part of the same API `complete()` already calls, not a new
   * surface. `costKey` defaults to `'label-photo-analysis'` since that's
   * this method's only current caller.
   */
  async completeVision(
    image: { data: Buffer; mimeType: string },
    prompt: string,
    options: LlmOptions = {},
  ): Promise<LlmResult> {
    const apiKey = this.requireApiKey();
    // Vision + structured JSON needs more output headroom than a short text
    // completion, and a lower temperature favours accurate extraction over
    // creative phrasing.
    const { timeoutMs, model, generationConfig } = this.buildGenerationParams(options, {
      defaultMaxTokens: 1536,
      defaultTemperature: 0.2,
    });
    const url = `${GeminiLlmProvider.BASE_URL}/${encodeURIComponent(model)}:generateContent`;
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: image.mimeType, data: image.data.toString('base64') } },
          ],
        },
      ],
      generationConfig,
    };
    return this.sendWithRetry(
      url,
      apiKey,
      JSON.stringify(requestBody),
      timeoutMs,
      'completeVision',
      'label-photo-analysis',
    );
  }

  private requireApiKey(): string {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ExternalServiceException(
        'Gemini',
        new Error('GEMINI_API_KEY not configured'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    return apiKey;
  }

  private buildGenerationParams(
    options: LlmOptions,
    defaults: { defaultMaxTokens?: number; defaultTemperature?: number } = {},
  ): { timeoutMs: number; model: string; generationConfig: Record<string, unknown> } {
    const timeoutMs = options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS;
    const model = options.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    const maxTokens = options.maxTokens ?? defaults.defaultMaxTokens ?? 512;
    const temperature = options.temperature ?? defaults.defaultTemperature ?? 0.3;
    const generationConfig: Record<string, unknown> = {
      temperature,
      maxOutputTokens: maxTokens,
    };
    if (options.json) {
      // Native structured output: the model is constrained to emit a single
      // JSON value, so downstream parsing can't be defeated by prose or fences.
      generationConfig.responseMimeType = 'application/json';
    }
    return { timeoutMs, model, generationConfig };
  }

  /** Retry loop shared by `complete`/`completeVision` — jittered exponential backoff. */
  private async sendWithRetry(
    url: string,
    apiKey: string,
    payload: string,
    timeoutMs: number,
    logTag: string,
    costKey: AiOperation = 'report-summary',
  ): Promise<LlmResult> {
    const start = Date.now();
    let lastError: Error = new Error(`Gemini ${logTag} request failed`);
    for (let attempt = 1; attempt <= AI_LLM_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(url, apiKey, payload, timeoutMs, start, costKey);
      } catch (err) {
        const failure = err as GeminiAttemptError;
        lastError = failure;
        const canRetry = failure.retryable === true && attempt < AI_LLM_MAX_ATTEMPTS;
        if (!canRetry) break;
        const delay = this.backoffDelay(attempt);
        this.logger.warn(
          `gemini.${logTag}.retry attempt=${attempt} status=${failure.status ?? 'net'} ` +
            `delayMs=${delay}: ${failure.message}`,
        );
        await this.sleep(delay);
      }
    }

    this.logger.error(`gemini.${logTag}.failed: ${lastError.message}`);
    throw new ExternalServiceException('Gemini', lastError, ErrorCode.AI_SERVICE_ERROR);
  }

  /**
   * Single attempt: one fetch bounded by its own AbortController timeout.
   * Throws a {@link GeminiAttemptError} tagged with whether the caller should
   * retry (transient HTTP status or a network error — but never a timeout).
   */
  private async attempt(
    url: string,
    apiKey: string,
    payload: string,
    timeoutMs: number,
    start: number,
    costKey: AiOperation = 'report-summary',
  ): Promise<LlmResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: payload,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw this.taggedError(
          `Gemini API returned ${res.status}: ${detail.slice(0, 300)}`,
          AI_LLM_RETRYABLE_STATUSES.has(res.status),
          res.status,
        );
      }

      const body = (await res.json()) as GeminiGenerateResponse;
      const candidate = body.candidates?.[0];
      const text =
        candidate?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('')
          .trim() ?? '';
      const tokensUsed = body.usageMetadata?.totalTokenCount ?? 0;
      const cost = AI_OPERATION_UNIT_COST[costKey];

      return {
        text,
        tokensUsed,
        cost,
        provider: 'gemini',
        durationMs: Date.now() - start,
        truncated: candidate?.finishReason === 'MAX_TOKENS',
      };
    } catch (err) {
      const e = err as GeminiAttemptError;
      // Already tagged (non-ok HTTP path) — propagate as-is.
      if (typeof e.retryable === 'boolean') throw e;
      // A wall-clock timeout is terminal: retrying would exceed the budget.
      if (e.name === 'AbortError') {
        throw this.taggedError(`Gemini request timed out after ${timeoutMs}ms`, false);
      }
      // Anything else thrown by fetch is a network-class error — retryable.
      throw this.taggedError(e.message || 'Gemini network error', true);
    } finally {
      clearTimeout(timer);
    }
  }

  private taggedError(message: string, retryable: boolean, status?: number): GeminiAttemptError {
    const e = new Error(message) as GeminiAttemptError;
    e.retryable = retryable;
    if (status !== undefined) e.status = status;
    return e;
  }

  /** Exponential backoff with full jitter, e.g. ~250ms, ~500ms (+ jitter). */
  private backoffDelay(attempt: number): number {
    const base = AI_LLM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * AI_LLM_RETRY_BASE_DELAY_MS);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Internal error carrying retry intent between an attempt and the retry loop. */
interface GeminiAttemptError extends Error {
  retryable?: boolean;
  status?: number;
}

/** Minimal shape of the Gemini `generateContent` response we consume. */
interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
