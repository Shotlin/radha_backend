import { Injectable } from '@nestjs/common';

import type { IngredientExplanationConfidence } from '@/db/schema/ingredient-explanations';

/**
 * BE-40 — LLM provider wrapper.
 *
 * Thin façade over the model provider so the explainer service can
 * stay vendor-agnostic. v1 is a deterministic stub — it returns mock
 * data shaped exactly like a real OpenAI / Claude response, and is
 * also useful when running offline or in test.
 *
 * The real provider (OpenAI / Claude) is plugged in by overriding
 * `LlmExplainerService` in the integrations module once BE-22 v2
 * lands. The contract is:
 *
 *   - `generate()` honours `timeoutMs` (default 10s per Req 45).
 *   - On success returns the four required fields plus `modelName`.
 *   - On timeout / provider error throws — the caller wraps it.
 */

export interface LlmExplainGenerateInput {
  /** System prompt — domain framing for the model. */
  system: string;
  /** User prompt — typically the ingredient slug. */
  user: string;
  /** ISO-639-1 locale (e.g. 'en', 'hi'). */
  language: string;
  /** Wall-clock cap on the call. Default 10s. */
  timeoutMs?: number;
}

export interface LlmExplainGenerateOutput {
  description: string;
  healthConsiderations: string;
  confidence: IngredientExplanationConfidence;
  modelName: string;
}

/** Default per-call wall-clock cap (Req 45 / T-v2.3). */
export const LLM_EXPLAINER_DEFAULT_TIMEOUT_MS = 10_000;

@Injectable()
export class LlmExplainerService {
  /**
   * Stable identifier for the model behind this wrapper. Persisted to
   * `ingredient_explanations.generated_by` so operators can run a
   * mass regenerate by filtering on this column.
   */
  readonly modelName = 'mock-llm-stub-v1';

  /**
   * Generate a plain-language ingredient explanation.
   *
   * v1 is a deterministic stub. It returns mock data shaped like the
   * real provider response so downstream code can be tested without
   * hitting OpenAI / Claude. Replace this with a real provider once
   * BE-22 v2 wires it up.
   */
  async generate(input: LlmExplainGenerateInput): Promise<LlmExplainGenerateOutput> {
    const timeoutMs = input.timeoutMs ?? LLM_EXPLAINER_DEFAULT_TIMEOUT_MS;
    // Resolve immediately — the mock has no I/O. We still race against
    // a timeout so the contract matches the real provider exactly.
    return this.withTimeout(this.buildMockResponse(input), timeoutMs);
  }

  private buildMockResponse(input: LlmExplainGenerateInput): LlmExplainGenerateOutput {
    const display = this.titleCase(input.user);
    return {
      description: `${display} is a food ingredient. Plain-language explanation will be provided here once the LLM provider is configured.`,
      healthConsiderations:
        'No specific health considerations are available yet. Consult a qualified dietitian for personalised advice.',
      confidence: 'low',
      modelName: this.modelName,
    };
  }

  private titleCase(slug: string): string {
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  /**
   * Wrap a promise with a wall-clock timeout. The timer is cleared on
   * resolution / rejection so the Node event loop can settle.
   */
  private withTimeout<T>(promise: Promise<T> | T, timeoutMs: number): Promise<T> {
    const wrapped = Promise.resolve(promise);
    if (timeoutMs <= 0) return wrapped;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`LLM explainer timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't let the timer block process exit during shutdown.
      timer.unref?.();

      wrapped.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
