import { Injectable, Logger } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { AI_LLM_DEFAULT_TIMEOUT_MS, AI_OPERATION_UNIT_COST } from '../ai.constants';
import type { AiProvider, ILlmProvider, LlmOptions, LlmResult } from '../types/ai.types';

type OpenAiModule = typeof import('openai');

/**
 * BE-22 v2 ADDENDUM — OpenAI LLM provider.
 *
 * Driver requirement: Req 45 (`GET /api/v1/ingredients/:slug/explanation`,
 * owned by BE-40) needs an LLM provider for the ingredient explainer
 * with permanent caching of explanations. Also used by BE-21 for
 * report-summary generation when `FEATURE_LLM_SUMMARIES` is on.
 *
 * Lazy-loaded via `import('openai').catch(() => null)` so the API
 * stays up if the package isn't installed. API key read from
 * `process.env.OPENAI_API_KEY` — BE-22 doesn't add a typed config key
 * to keep the shared `env.schema.ts` untouched (orchestrator
 * checklist flags it).
 */
@Injectable()
export class OpenAiLlmProvider implements ILlmProvider {
  readonly name: AiProvider = 'openai';
  private readonly logger = new Logger(OpenAiLlmProvider.name);

  private sdk: OpenAiModule | null = null;
  private clientInstance: InstanceType<OpenAiModule['OpenAI']> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    if (this.config.isTest) return false;
    return Boolean(process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY);
  }

  async complete(prompt: string, options: LlmOptions = {}): Promise<LlmResult> {
    if (!this.isConfigured()) {
      throw new ExternalServiceException(
        'OpenAI',
        new Error('OPENAI_API_KEY not configured'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS;
    const model =
      options.model ??
      process.env.OPENAI_MODEL ??
      process.env.OPENROUTER_MODEL ??
      'openrouter/free';
    const maxTokens = options.maxTokens ?? 512;
    const temperature = options.temperature ?? 0.3;

    try {
      const { client } = await this.ensureClient();
      const request = {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
        ...(options.json ? { response_format: { type: 'json_object' as const } } : {}),
        ...(process.env.OPENROUTER_API_KEY ? { reasoning: { enabled: false } } : {}),
      } as unknown as Parameters<typeof client.chat.completions.create>[0];
      const response = (await this.withTimeout(
        client.chat.completions.create(request),
        timeoutMs,
      )) as {
        choices?: Array<{
          message?: { content?: string | null };
          finish_reason?: string | null;
        }>;
        usage?: { total_tokens?: number };
      };
      const choice = response.choices?.[0];
      const text = choice?.message?.content ?? '';
      const tokensUsed = response.usage?.total_tokens ?? 0;
      // Conservative cost approximation: report-summary unit cost per
      // call. Actual per-token cost varies by model; downstream
      // aggregations use the persisted value for accounting.
      const cost = AI_OPERATION_UNIT_COST['report-summary'];
      return {
        text,
        tokensUsed,
        cost,
        provider: 'openai',
        durationMs: Date.now() - start,
        truncated: choice?.finish_reason === 'length',
      };
    } catch (err) {
      this.logger.error(`openai.complete.failed: ${(err as Error).message}`);
      throw new ExternalServiceException('OpenAI', err as Error, ErrorCode.AI_SERVICE_ERROR);
    }
  }

  /**
   * Multimodal completion — a prompt plus one inline image, via the
   * standard OpenAI-compatible `image_url` (data URI) content block.
   * OpenRouter proxies this straight through to whatever vision-capable
   * model `OPENROUTER_MODEL` names (e.g. `openai/gpt-4o-mini`), so this
   * works for OpenRouter the same way it would against OpenAI directly.
   */
  async completeVision(
    image: { data: Buffer; mimeType: string },
    prompt: string,
    options: LlmOptions = {},
  ): Promise<LlmResult> {
    if (!this.isConfigured()) {
      throw new ExternalServiceException(
        'OpenAI',
        new Error('OPENAI_API_KEY not configured'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS;
    const model =
      options.model ??
      process.env.OPENAI_MODEL ??
      process.env.OPENROUTER_MODEL ??
      'openrouter/free';
    // Vision + structured JSON needs more output headroom than a short
    // text completion, and a lower temperature favours accurate
    // extraction over creative phrasing — same rationale as Gemini's
    // completeVision.
    const maxTokens = options.maxTokens ?? 1024;
    const temperature = options.temperature ?? 0.2;
    const dataUrl = `data:${image.mimeType};base64,${image.data.toString('base64')}`;

    try {
      const { client } = await this.ensureClient();
      const request = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: maxTokens,
        temperature,
        ...(options.json ? { response_format: { type: 'json_object' as const } } : {}),
        ...(process.env.OPENROUTER_API_KEY ? { reasoning: { enabled: false } } : {}),
      } as unknown as Parameters<typeof client.chat.completions.create>[0];
      const response = (await this.withTimeout(
        client.chat.completions.create(request),
        timeoutMs,
      )) as {
        choices?: Array<{
          message?: { content?: string | null };
          finish_reason?: string | null;
        }>;
        usage?: { total_tokens?: number };
      };
      const choice = response.choices?.[0];
      const text = choice?.message?.content ?? '';
      const tokensUsed = response.usage?.total_tokens ?? 0;
      const cost = AI_OPERATION_UNIT_COST['date-photo-analysis'];
      return {
        text,
        tokensUsed,
        cost,
        provider: 'openai',
        durationMs: Date.now() - start,
        truncated: choice?.finish_reason === 'length',
      };
    } catch (err) {
      this.logger.error(`openai.completeVision.failed: ${(err as Error).message}`);
      throw new ExternalServiceException('OpenAI', err as Error, ErrorCode.AI_SERVICE_ERROR);
    }
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
        'OpenAI',
        new Error('openai package is not installed'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    this.sdk = mod;
    this.clientInstance = new mod.OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '',
      baseURL: process.env.OPENAI_BASE_URL ?? process.env.OPENROUTER_BASE_URL,
    });
    return { sdk: this.sdk, client: this.clientInstance };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`OpenAI request timed out after ${ms}ms`)), ms),
      ),
    ]);
  }
}
