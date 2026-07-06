import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import type { IngredientExplanationRow } from '@/db/schema/ingredient-explanations';
import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import {
  DEFAULT_LOCALE,
  IngredientExplanationDto,
  SupportedLocale,
  resolveLocale,
} from '../dto/ingredient-explanation.dto';
import { IngredientExplanationRepository } from '../repositories/ingredient-explanation.repository';
import { isNormalisedIngredientSlug, normaliseIngredientSlug } from '../utils/slug.util';
import { LLM_EXPLAINER_DEFAULT_TIMEOUT_MS, LlmExplainerService } from './llm-explainer.service';

/**
 * BE-40 — Ingredient explainer service.
 *
 * Cache-first read path. On miss we call the LLM with a 10s wall-clock
 * cap and persist the result idempotently. On error or timeout we
 * return a graceful low-confidence fallback and capture the exception
 * via `IErrorTrackingService` so operators see it without breaking
 * the user's request.
 *
 *   1. Normalise the slug (lowercase kebab-case alphanumeric+hyphen).
 *   2. Resolve the locale; unsupported → fallback to 'en'.
 *   3. Cache hit → return immediately (<50ms in practice).
 *   4. Cache miss → call LLM, persist via `ON CONFLICT DO NOTHING`.
 *   5. LLM error / timeout → return graceful fallback, capture the
 *      exception, do NOT persist (so a real LLM result lands later).
 */
@Injectable()
export class IngredientExplainerService {
  /** Per-call wall-clock cap for the LLM. */
  private readonly llmTimeoutMs = LLM_EXPLAINER_DEFAULT_TIMEOUT_MS;

  constructor(
    private readonly repo: IngredientExplanationRepository,
    private readonly llm: LlmExplainerService,
    private readonly logger: LoggerService,
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking: IErrorTrackingService,
  ) {}

  /**
   * Get an ingredient explanation. Returns a `cached: true` row when
   * the cache hits, generates and persists on miss, falls back
   * gracefully on LLM failure.
   */
  async getExplanation(
    rawSlug: string,
    rawLocale?: string | null,
  ): Promise<IngredientExplanationDto> {
    const slug = normaliseIngredientSlug(rawSlug);
    if (!slug || !isNormalisedIngredientSlug(slug)) {
      throw new BadRequestException({
        code: 'INVALID_INGREDIENT_SLUG',
        message: 'Ingredient slug is required and must be alphanumeric with hyphens',
      });
    }

    const locale = resolveLocale(rawLocale);

    // 1. Cache hit — return immediately.
    const cached = await this.repo.findOne(slug, locale);
    if (cached) {
      return this.toCachedDto(cached, locale);
    }

    // 2. Cache miss — call the LLM with a hard timeout and persist.
    try {
      const generated = await this.llm.generate({
        system:
          'Explain this food ingredient in plain language with health considerations. Keep the description neutral, factual, and non-alarmist. Output strictly the requested fields.',
        user: slug,
        language: locale,
        timeoutMs: this.llmTimeoutMs,
      });

      const persisted = await this.repo.insertIfMissing({
        ingredientSlug: slug,
        language: locale,
        description: generated.description,
        healthConsiderations: generated.healthConsiderations,
        confidence: generated.confidence,
        generatedBy: generated.modelName,
      });

      this.logger.info('ingredient_explainer.generated', {
        slug,
        locale,
        model: generated.modelName,
      });

      // The persisted row is the source of truth — same fields, plus
      // `generatedAt` from the database default.
      return {
        ingredientSlug: persisted.ingredientSlug,
        description: persisted.description,
        healthConsiderations: persisted.healthConsiderations,
        confidence: persisted.confidence as IngredientExplanationDto['confidence'],
        language: persisted.language as SupportedLocale,
        generatedBy: persisted.generatedBy,
        generatedAt: persisted.generatedAt.toISOString(),
        cached: false,
      };
    } catch (err) {
      this.errorTracking.captureException(err as Error, {
        module: 'ingredient-explainer',
        metadata: { slug, locale },
      });
      this.logger.warn('ingredient_explainer.fallback', {
        slug,
        locale,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return this.buildFallback(slug, locale);
    }
  }

  /** Graceful fallback shape returned when the LLM errors or times out. */
  private buildFallback(slug: string, locale: SupportedLocale): IngredientExplanationDto {
    return {
      ingredientSlug: slug,
      description: 'Explanation unavailable',
      healthConsiderations: '',
      confidence: 'low',
      language: locale ?? DEFAULT_LOCALE,
      cached: false,
    };
  }

  private toCachedDto(
    row: IngredientExplanationRow,
    locale: SupportedLocale,
  ): IngredientExplanationDto {
    return {
      ingredientSlug: row.ingredientSlug,
      description: row.description,
      healthConsiderations: row.healthConsiderations,
      confidence: row.confidence as IngredientExplanationDto['confidence'],
      language: (row.language as SupportedLocale) ?? locale,
      generatedBy: row.generatedBy,
      generatedAt: row.generatedAt.toISOString(),
      cached: true,
    };
  }
}
