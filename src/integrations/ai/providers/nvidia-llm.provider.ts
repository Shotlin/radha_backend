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
import type { AiProvider, ILlmProvider, LlmOptions, LlmResult } from '../types/ai.types';

type OpenAiModule = typeof import('openai');

/**
 * NVIDIA NIM LLM provider — DeepSeek, via an OpenAI-SDK-compatible endpoint.
 *
 * Backs the same `ILlmProvider` contract as `GeminiLlmProvider` /
 * `OpenAiLlmProvider` (ingredient explainer, label-transcript analysis,
 * report-summary generation). Reuses the `openai` npm SDK already a
 * dependency for `OpenAiLlmProvider` — just pointed at NVIDIA's
 * OpenAI-compatible NIM base URL instead of api.openai.com, so no new HTTP
 * client is introduced.
 *
 * Retry/backoff mirrors `GeminiLlmProvider`: transient 429/5xx are retried
 * with jittered exponential backoff bounded by `AI_LLM_MAX_ATTEMPTS`; a
 * wall-clock timeout is terminal (retrying would blow the caller's budget).
 *
 * `chat_template_kwargs` (DeepSeek's NIM-specific "thinking" reasoning mode)
 * isn't part of the OpenAI SDK's typed request shape — passed through as an
 * untyped extra field since the NIM endpoint accepts it over the wire.
 *
 * Configuration (read from `process.env` directly, matching the existing
 * `GeminiLlmProvider`/`OpenAiLlmProvider` convention of not expanding the
 * shared typed env schema for optional AI keys):
 *   - `NVIDIA_API_KEY`  — required to activate the provider.
 *   - `NVIDIA_BASE_URL` — optional, defaults to NVIDIA's NIM endpoint.
 *   - `NVIDIA_MODEL`    — optional, defaults to `deepseek-ai/deepseek-v4-flash`.
 */
@Injectable()
export class NvidiaLlmProvider implements ILlmProvider {
  readonly name: AiProvider = 'nvidia';
  private readonly logger = new Logger(NvidiaLlmProvider.name);
  private static readonly DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
  private static readonly DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-flash';

  private sdk: OpenAiModule | null = null;
  private clientInstance: InstanceType<OpenAiModule['OpenAI']> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    if (this.config.isTest) return false;
    return Boolean(process.env.NVIDIA_API_KEY);
  }

  async complete(prompt: string, options: LlmOptions = {}): Promise<LlmResult> {
    if (!this.isConfigured()) {
      throw new ExternalServiceException(
        'NVIDIA',
        new Error('NVIDIA_API_KEY not configured'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS;
    const model = options.model ?? process.env.NVIDIA_MODEL ?? NvidiaLlmProvider.DEFAULT_MODEL;
    const maxTokens = options.maxTokens ?? 512;
    const temperature = options.temperature ?? 0.3;

    let lastError: Error = new Error('NVIDIA request failed');
    for (let attempt = 1; attempt <= AI_LLM_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(prompt, model, maxTokens, temperature, options.json, timeoutMs, start);
      } catch (err) {
        const failure = err as NvidiaAttemptError;
        lastError = failure;
        const canRetry = failure.retryable === true && attempt < AI_LLM_MAX_ATTEMPTS;
        if (!canRetry) break;
        const delay = this.backoffDelay(attempt);
        this.logger.warn(
          `nvidia.complete.retry attempt=${attempt} status=${failure.status ?? 'net'} ` +
            `delayMs=${delay}: ${failure.message}`,
        );
        await this.sleep(delay);
      }
    }

    this.logger.error(`nvidia.complete.failed: ${lastError.message}`);
    throw new ExternalServiceException('NVIDIA', lastError, ErrorCode.AI_SERVICE_ERROR);
  }

  /** Single attempt: one SDK call bounded by its own timeout race. */
  private async attempt(
    prompt: string,
    model: string,
    maxTokens: number,
    temperature: number,
    json: boolean | undefined,
    timeoutMs: number,
    start: number,
  ): Promise<LlmResult> {
    try {
      const { client } = await this.ensureClient();
      const params = {
        model,
        messages: [{ role: 'user' as const, content: prompt }],
        max_tokens: maxTokens,
        temperature,
        top_p: 0.95,
        // NVIDIA NIM extension: DeepSeek reasoning ("thinking") mode at high
        // effort. Not in the OpenAI SDK's typed params — sent as extra JSON.
        chat_template_kwargs: { thinking: true, reasoning_effort: 'high' },
        ...(json ? { response_format: { type: 'json_object' as const } } : {}),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chat_template_kwargs is a NIM-only field the OpenAI SDK's types don't model
      const response = await this.withTimeout(client.chat.completions.create(params as any), timeoutMs);
      const choice = response.choices?.[0];
      const text = choice?.message?.content ?? '';
      const tokensUsed = response.usage?.total_tokens ?? 0;
      const cost = AI_OPERATION_UNIT_COST['report-summary'];
      return {
        text,
        tokensUsed,
        cost,
        provider: 'nvidia',
        durationMs: Date.now() - start,
        truncated: choice?.finish_reason === 'length',
      };
    } catch (err) {
      const e = err as { status?: number; message?: string; name?: string };
      if (e.name === 'AbortError' || /timed out/i.test(e.message ?? '')) {
        throw this.taggedError(`NVIDIA request timed out after ${timeoutMs}ms`, false);
      }
      const status = e.status;
      const retryable = typeof status === 'number' && AI_LLM_RETRYABLE_STATUSES.has(status);
      throw this.taggedError(e.message || 'NVIDIA request failed', retryable, status);
    }
  }

  private taggedError(message: string, retryable: boolean, status?: number): NvidiaAttemptError {
    const e = new Error(message) as NvidiaAttemptError;
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

  private async ensureClient(): Promise<{
    sdk: OpenAiModule;
    client: InstanceType<OpenAiModule['OpenAI']>;
  }> {
    if (this.sdk && this.clientInstance) {
      return { sdk: this.sdk, client: this.clientInstance };
    }
    const mod = (await import('openai').catch(() => null)) as OpenAiModule | null;
    if (!mod) {
      throw new ExternalServiceException(
        'NVIDIA',
        new Error('openai package is not installed'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    this.sdk = mod;
    this.clientInstance = new mod.OpenAI({
      apiKey: process.env.NVIDIA_API_KEY ?? '',
      baseURL: process.env.NVIDIA_BASE_URL ?? NvidiaLlmProvider.DEFAULT_BASE_URL,
    });
    return { sdk: this.sdk, client: this.clientInstance };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`NVIDIA request timed out after ${ms}ms`)), ms),
      ),
    ]);
  }
}

/** Internal error carrying retry intent between an attempt and the retry loop. */
interface NvidiaAttemptError extends Error {
  retryable?: boolean;
  status?: number;
}
