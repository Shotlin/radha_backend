import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import {
  AI_EXPLANATION_RULE_VERSION,
  AI_EXPLANATION_TEXT_MAX,
  AI_LLM_DEFAULT_TIMEOUT_MS,
} from '../ai.constants';
import { AiCircuitBreakerService } from './ai-circuit-breaker.service';
import { AiExplanationCacheRepository } from '../repositories/ai-explanation-cache.repository';
import { GeminiLlmProvider } from '../providers/gemini-llm.provider';
import { MockAiProvider } from '../providers/mock-ai.provider';
import { OpenAiLlmProvider } from '../providers/openai-llm.provider';
import { NutritionPanelSchema } from '@/modules/barcode-learning/dto/nutrition-panel.dto';
import {
  DatePhotoAnalysisResult,
  ILlmProvider,
  IngredientExplanationResult,
  LabelAnalysisResult,
  LLM_PROVIDER_TOKEN,
  LlmOptions,
  LlmResult,
} from '../types/ai.types';
import { truncateForStorage } from '../utils/ocr-text-parser.utils';

interface SummaryInput {
  reportType?: string;
  storeId?: string;
  summary?: Record<string, unknown>;
  data?: unknown;
}

/**
 * BE-22 — LLM façade.
 *
 *   - Routes generic completions through the active `ILlmProvider`,
 *     guarded by the per-provider circuit breaker.
 *   - Owns the report-summary template fallback so callers can
 *     degrade gracefully when the LLM is disabled or down.
 *   - Owns the ingredient-explainer cache (Req 45 — permanent
 *     caching). On cache hit we skip the LLM entirely; on miss we
 *     call, persist the parsed JSON, and return.
 */
@Injectable()
export class LlmService {
  constructor(
    @Inject(LLM_PROVIDER_TOKEN) private readonly provider: ILlmProvider,
    private readonly mock: MockAiProvider,
    private readonly breaker: AiCircuitBreakerService,
    private readonly cacheRepo: AiExplanationCacheRepository,
    private readonly logger: LoggerService,
    // Injected directly (not via LLM_PROVIDER_TOKEN) — the generic
    // provider cascade resolves NVIDIA before Gemini when both are
    // configured (ai.module.ts), and NVIDIA's provider is text-only.
    // analyzeLabelPhoto needs vision specifically, so it must always talk
    // to Gemini regardless of which provider the generic cascade picked.
    private readonly geminiProvider: GeminiLlmProvider,
    // Same reasoning as geminiProvider above: analyzeDatePhoto always
    // wants the OpenRouter/OpenAI-configured model specifically (the
    // operator picks it via OPENROUTER_MODEL), not whatever the generic
    // cascade happens to resolve to.
    private readonly openAiProvider: OpenAiLlmProvider,
  ) {}

  /**
   * Try the active provider, fall back to the mock if the breaker is
   * open or the call fails. Honours `options.timeoutMs` (default 10 s
   * per Req 45 / T-v2.3).
   */
  async complete(prompt: string, options: LlmOptions = {}): Promise<LlmResult> {
    const opts: LlmOptions = {
      ...options,
      timeoutMs: options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS,
    };

    if (!this.provider.isConfigured() || !this.breaker.isAllowed(this.provider.name)) {
      return this.mock.complete(prompt, opts);
    }

    try {
      const result = await this.provider.complete(prompt, opts);
      this.breaker.recordSuccess(this.provider.name);
      return result;
    } catch (err) {
      this.breaker.recordFailure(this.provider.name);
      this.logger.warn('ai.llm.fallback_to_mock', {
        provider: this.provider.name,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      // Return a graceful failure shape rather than throwing — Req 45
      // explicitly demands "graceful failure" on timeout.
      const mockResult = await this.mock.complete(prompt, opts);
      return {
        ...mockResult,
        truncated: true,
      };
    }
  }

  /** Build a deterministic plain-text summary when the LLM is unavailable. */
  buildTemplateSummary(input: SummaryInput): string {
    const summary = (input.summary ?? {}) as Record<string, number | undefined>;
    const parts: string[] = [];
    if (typeof summary.totalScans === 'number') {
      parts.push(`Total scans: ${summary.totalScans}`);
    }
    if (typeof summary.matchedScans === 'number' && typeof summary.totalScans === 'number') {
      const rate =
        summary.totalScans > 0 ? Math.round((summary.matchedScans / summary.totalScans) * 100) : 0;
      parts.push(`Match rate: ${rate}%`);
    }
    if (typeof summary.expiredItems === 'number') {
      parts.push(`Expired items: ${summary.expiredItems}`);
    }
    if (typeof summary.nearExpiryItems === 'number') {
      parts.push(`Near-expiry items: ${summary.nearExpiryItems}`);
    }
    if (parts.length === 0) {
      return 'No data available for summary.';
    }
    return `${input.reportType ?? 'Report'} summary: ${parts.join('. ')}.`;
  }

  /** Generate a report summary, preferring the LLM if configured. */
  async generateSummary(input: SummaryInput, options: LlmOptions = {}): Promise<LlmResult> {
    if (!this.provider.isConfigured()) {
      const text = this.buildTemplateSummary(input);
      return {
        text,
        tokensUsed: 0,
        cost: 0,
        provider: 'mock',
        durationMs: 1,
      };
    }
    const prompt = this.buildSummaryPrompt(input);
    return this.complete(prompt, options);
  }

  /**
   * Generate (or fetch from cache) an ingredient explanation.
   *
   * Implements the Req 45 contract: deterministic, locale-aware,
   * permanently cached. The first call burns budget; every subsequent
   * call for the same `(slug, locale, ruleVersion)` is free.
   */
  async explainIngredient(
    slug: string,
    options: LlmOptions = {},
  ): Promise<IngredientExplanationResult> {
    const locale = options.locale ?? 'en';
    const ruleVersion = AI_EXPLANATION_RULE_VERSION;
    const cacheKey = slug.trim().toLowerCase();

    const cached = await this.cacheRepo.findCached(
      'ingredient-explanation',
      cacheKey,
      locale,
      ruleVersion,
    );
    if (cached) {
      // Best-effort hit counter; failure must not break the response.
      this.cacheRepo.incrementHit(cached.id).catch(() => undefined);
      const payload = cached.response as unknown as IngredientExplanationResult;
      return {
        ...payload,
        slug: cacheKey,
        locale,
        cached: true,
        provider: cached.provider,
        cost: 0,
        durationMs: 0,
      };
    }

    const prompt = this.buildIngredientPrompt(cacheKey, locale);
    const llm = await this.complete(prompt, {
      ...options,
      timeoutMs: options.timeoutMs ?? Math.max(AI_LLM_DEFAULT_TIMEOUT_MS, 25_000),
      // Structured output — the ingredient explanation is a fixed JSON shape.
      json: true,
    });

    const parsed = this.parseIngredientResponse(cacheKey, locale, llm.text);
    const payload: IngredientExplanationResult = {
      ...parsed,
      cached: false,
      provider: llm.provider,
      cost: llm.cost,
      durationMs: llm.durationMs,
    };

    // Persist for permanent reuse — failure to persist must not break
    // the response.
    try {
      await this.cacheRepo.upsertCached({
        operation: 'ingredient-explanation',
        cacheKey,
        locale,
        ruleVersion,
        response: payload as unknown as Record<string, unknown>,
        responseText: truncateForStorage(llm.text, AI_EXPLANATION_TEXT_MAX),
        provider: llm.provider,
        cost: String(llm.cost),
        tokensUsed: llm.tokensUsed,
      });
    } catch (err) {
      this.logger.warn('ai.explanation.cache_persist_failed', {
        slug: cacheKey,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    }

    return payload;
  }

  /**
   * Parse an OCR'd product-label transcript into a structured analysis via the
   * LLM (Gemini Flash). This backs the consumer "scan the label" fallback: when
   * a barcode lookup misses, the mobile does on-device ML Kit OCR and sends the
   * raw transcript here — far cheaper than uploading the image for vision.
   *
   * Never throws: an unconfigured/failed provider degrades to the mock via
   * {@link complete}, and an unparseable response degrades to a warning-bearing
   * low-confidence result so the UI always has something honest to render.
   */
  async analyzeLabelText(
    transcript: string,
    options: LlmOptions = {},
  ): Promise<LabelAnalysisResult> {
    const locale = options.locale ?? 'en';
    const cleaned = transcript.trim();
    if (cleaned.length === 0) {
      return {
        confidence: 0,
        provider: 'mock',
        cost: 0,
        durationMs: 0,
        warnings: ['Empty transcript — nothing to analyze'],
      };
    }

    const prompt = this.buildLabelPrompt(cleaned, locale);
    const llm = await this.complete(prompt, {
      ...options,
      timeoutMs: options.timeoutMs ?? Math.max(AI_LLM_DEFAULT_TIMEOUT_MS, 25_000),
      // Label analysis has several arrays and a nutrition object. The
      // previous provider default (512) could truncate the JSON response
      // before it reached the parser, causing the UI's unavailable state.
      maxTokens: options.maxTokens ?? 1_600,
      // Structured output — the label analysis is a fixed JSON shape.
      json: true,
    });
    return this.parseLabelResponse(llm);
  }

  /**
   * Parse a product-label PHOTO into a structured analysis via Gemini's
   * vision-native multimodal API — the image is sent directly, not
   * flattened to text first. This is the fix for curved/warped labels
   * where on-device OCR's flatten-to-text-then-regex approach loses table
   * geometry (a nutrient's name and its value end up on unpredictably
   * different "lines" once curvature scrambles ML Kit's own reading
   * order): a vision model reads the table as an image, so it isn't
   * subject to that failure mode.
   *
   * Deliberately talks to `geminiProvider` directly, not the generic
   * `complete()`/provider cascade (see the constructor comment — NVIDIA
   * wins the generic cascade when both are configured, and it's
   * text-only). Mirrors `complete()`'s own isConfigured/circuit-breaker/
   * graceful-degrade discipline so this never throws for a configuration
   * or availability reason — failures return a mock-shaped, honest
   * "unavailable" result, same contract as `analyzeLabelText`.
   */
  async analyzeLabelPhoto(
    imageBuffer: Buffer,
    mimeType: string,
    options: LlmOptions = {},
  ): Promise<LabelAnalysisResult> {
    if (!this.geminiProvider.isConfigured() || !this.breaker.isAllowed('gemini')) {
      return {
        confidence: 0,
        provider: 'mock',
        cost: 0,
        durationMs: 0,
        warnings: ['Gemini vision unavailable — falling back to on-device scan'],
      };
    }

    const locale = options.locale ?? 'en';
    const prompt = this.buildLabelPhotoPrompt(locale);
    try {
      const llm = await this.geminiProvider.completeVision(
        { data: imageBuffer, mimeType },
        prompt,
        {
          ...options,
          timeoutMs: options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS,
          json: true,
        },
      );
      this.breaker.recordSuccess('gemini');
      return this.parseLabelPhotoResponse(llm);
    } catch (err) {
      this.breaker.recordFailure('gemini');
      this.logger.warn('ai.llm.photo_fallback_to_mock', {
        provider: 'gemini',
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return {
        confidence: 0,
        provider: 'mock',
        cost: 0,
        durationMs: 0,
        warnings: ['Photo analysis failed — falling back to on-device scan'],
      };
    }
  }

  /**
   * Photo → {expiryDate, mfgDate, batchNumber} only — the fallback for
   * labels where on-device OCR (mobile ML Kit, streamed low-res video
   * frames) can't get a reliable read at all. The clearest real case:
   * dates debossed/embossed directly into curved, translucent plastic
   * (no ink, near-zero contrast) — ML Kit produced near-random garbage
   * across ~20 consecutive frames on a real device (I2217, 2026-08-22)
   * trying to read exactly this. A single well-lit still photo sent to a
   * vision-capable LLM reasons about the image semantically rather than
   * doing raw per-pixel pattern matching, which is why this succeeds
   * where streamed local OCR does not.
   *
   * Deliberately talks to `openAiProvider` directly (see constructor
   * comment) and asks for ONLY these three fields, not a full label
   * parse — smaller prompt, smaller response, lower cost, and a tighter
   * task the model is less likely to hallucinate on.
   */
  async analyzeDatePhoto(
    imageBuffer: Buffer,
    mimeType: string,
    options: LlmOptions = {},
  ): Promise<DatePhotoAnalysisResult> {
    if (!this.openAiProvider.isConfigured() || !this.breaker.isAllowed('openai')) {
      return {
        confidence: 0,
        provider: 'mock',
        cost: 0,
        durationMs: 0,
        warnings: ['Vision date extraction unavailable — falling back to on-device scan'],
      };
    }

    const prompt = this.buildDatePhotoPrompt();
    try {
      const llm = await this.openAiProvider.completeVision(
        { data: imageBuffer, mimeType },
        prompt,
        {
          ...options,
          timeoutMs: options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS,
          json: true,
        },
      );
      this.breaker.recordSuccess('openai');
      return this.parseDatePhotoResponse(llm);
    } catch (err) {
      this.breaker.recordFailure('openai');
      this.logger.warn('ai.llm.date_photo_fallback_to_mock', {
        provider: 'openai',
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return {
        confidence: 0,
        provider: 'mock',
        cost: 0,
        durationMs: 0,
        warnings: ['Photo date extraction failed — falling back to on-device scan'],
      };
    }
  }

  private buildDatePhotoPrompt(): string {
    return [
      'You are reading the expiry/manufacturing date printed, embossed, or',
      'debossed on a packaged grocery product. The photo may show low',
      'contrast (text embossed into curved, translucent plastic with no',
      'ink), glare, or a curved surface — read carefully.',
      'Return STRICT JSON with these keys:',
      '  expiryDate (string "YYYY-MM-DD" or null),',
      '  mfgDate (string "YYYY-MM-DD" or null),',
      '  batchNumber (string or null, the batch/lot code near the dates).',
      'Indian packs often print DD/MM/YY — 27 means 2027, not 1927 or year 27.',
      'If you see two bare (unlabeled) dates with no EXP/MFG/BB wording, the',
      'earlier one is mfgDate and the later one is expiryDate.',
      'Never invent a value that is not actually visible in the photo — use',
      'null for any field you cannot read, rather than guessing. Do not',
      'include any text outside the JSON object.',
    ].join('\n');
  }

  /** YYYY-MM-DD, year 2000–2100 — rejects hallucinated/garbled dates like "0112-01-31". */
  private static readonly ISO_DATE_RE = /^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  private parseDatePhotoResponse(llm: LlmResult): DatePhotoAnalysisResult {
    const base: Pick<DatePhotoAnalysisResult, 'provider' | 'cost' | 'durationMs'> = {
      provider: llm.provider,
      cost: llm.cost,
      durationMs: llm.durationMs,
    };
    const validDate = (v: unknown): string | undefined =>
      typeof v === 'string' && LlmService.ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v))
        ? v
        : undefined;

    try {
      const cleaned = this.extractJsonCandidate(llm.text);
      const parsed = JSON.parse(cleaned) as {
        expiryDate?: string | null;
        mfgDate?: string | null;
        batchNumber?: string | null;
      };

      const expiryDate = validDate(parsed.expiryDate ?? undefined);
      const mfgDate = validDate(parsed.mfgDate ?? undefined);
      const result: DatePhotoAnalysisResult = {
        ...base,
        expiryDate,
        mfgDate,
        batchNumber: this.shortString(parsed.batchNumber ?? undefined),
        // A read that yields a valid expiry date is the useful case this
        // path exists for; mfg/batch alone without expiry is weaker.
        confidence: expiryDate ? 0.75 : 0.2,
      };
      if (llm.truncated) {
        result.warnings = ['AI service degraded — result may be incomplete'];
        result.confidence = Math.min(result.confidence, 0.3);
      }
      return result;
    } catch {
      return {
        ...base,
        confidence: 0,
        warnings: ['Could not parse date photo analysis — try a clearer photo'],
      };
    }
  }

  private buildLabelPrompt(transcript: string, locale: string): string {
    return [
      'You are a food-label analyst. You are given the raw OCR transcript of a',
      'packaged food/grocery product label. The text may be noisy, partial, or',
      'mixed-language (English + an Indian language).',
      `Respond in ${locale === 'en' ? 'English' : locale}.`,
      'Extract what you can and return STRICT JSON with these keys:',
      '  productName (string or null), brand (string or null),',
      '  category (string or null), ingredients (array of strings),',
      '  allergens (array of strings), nutritionalInfo (object mapping nutrient',
      '  name to a number per 100g, or empty object),',
      '  healthFlags (array of short concern strings like "high sugar",',
      '  "ultra-processed", "high sodium"),',
      '  summary (a detailed 4-6 sentence product-specific health assessment, not a slogan or two-line summary),',
      '  bodyEffects (array of 2-5 clear sentences describing what the ingredients/nutrients may do in the body after consumption; distinguish short-term effects from long-term risk and do not diagnose),',
      '  whyItMatters (one direct sentence explaining the concern using the label evidence),',
      '  whoShouldLimit (array of concise groups who should limit or avoid it, such as children, people with diabetes, or people with caffeine sensitivity; use an empty array when not supported),',
      '  practicalAdvice (2-3 actionable sentences suggesting portion/frequency guidance and a healthier everyday alternative).',
      'Be clear and honest, not vague: say "limit" or "avoid" only when the label evidence supports it.',
      'Do not diagnose disease, claim the product causes disease, or invent product facts.',
      'Never invent values that are not supported by the transcript — use null or',
      'empty arrays when unknown. Do not include any text outside the JSON object.',
      '',
      'LABEL TRANSCRIPT:',
      transcript.slice(0, 4000),
    ].join('\n');
  }

  private parseLabelResponse(llm: LlmResult): LabelAnalysisResult {
    const base: Pick<LabelAnalysisResult, 'provider' | 'cost' | 'durationMs'> = {
      provider: llm.provider,
      cost: llm.cost,
      durationMs: llm.durationMs,
    };
    try {
      const cleaned = this.extractJsonCandidate(llm.text);
      const parsed = JSON.parse(cleaned) as {
        productName?: string | null;
        brand?: string | null;
        category?: string | null;
        ingredients?: unknown;
        allergens?: unknown;
        nutritionalInfo?: unknown;
        healthFlags?: unknown;
        summary?: string | null;
        bodyEffects?: unknown;
        whyItMatters?: string | null;
        whoShouldLimit?: unknown;
        practicalAdvice?: string | null;
      };

      const productName = this.shortString(parsed.productName ?? undefined);
      const result: LabelAnalysisResult = {
        ...base,
        productName,
        brand: this.shortString(parsed.brand ?? undefined),
        category: this.shortString(parsed.category ?? undefined),
        ingredients: this.stringArray(parsed.ingredients),
        allergens: this.stringArray(parsed.allergens),
        nutritionalInfo: this.numberRecord(parsed.nutritionalInfo),
        healthFlags: this.stringArray(parsed.healthFlags),
        summary: this.shortString(parsed.summary ?? undefined),
        bodyEffects: this.stringArray(parsed.bodyEffects),
        whyItMatters: this.shortString(parsed.whyItMatters ?? undefined),
        whoShouldLimit: this.stringArray(parsed.whoShouldLimit),
        practicalAdvice: this.shortString(parsed.practicalAdvice ?? undefined),
        // Confidence heuristic: a parsed name + some ingredients is a solid read.
        confidence: productName ? 0.7 : 0.35,
      };
      if (llm.truncated) {
        result.warnings = ['AI service degraded — result may be incomplete'];
        result.confidence = Math.min(result.confidence, 0.3);
      }
      return result;
    } catch {
      return {
        ...base,
        confidence: 0,
        warnings: ['Could not parse label analysis — try a clearer photo'],
      };
    }
  }

  private buildLabelPhotoPrompt(locale: string): string {
    return [
      'You are a food-label analyst. You are given a PHOTO of a packaged',
      'food/grocery product label — read it directly, including any',
      'nutrition-facts table, even if the pack surface is curved or the',
      'table columns are not perfectly aligned in the image.',
      `Respond in ${locale === 'en' ? 'English' : locale}.`,
      'Return STRICT JSON with these keys:',
      '  productName (string or null), brand (string or null),',
      '  category (string or null), ingredients (array of strings),',
      '  allergens (array of strings),',
      '  nutrition (object with these NUMBER-OR-NULL keys, values per the',
      '  serving basis printed on the label — usually "per 100g" or "per',
      '  100ml" — report the printed number as-is, do not convert units):',
      '    servingSize (number), servingUnit ("g" or "ml"),',
      '    calories (kcal), protein (g), carbohydrates (g), sugars (g),',
      '    fat (g), saturatedFat (g), transFat (g), fiber (g), sodium (mg),',
      '  healthFlags (array of short concern strings like "high sugar",',
      '  "ultra-processed", "high sodium"),',
      '  summary (one plain, non-alarmist sentence under 200 characters).',
      'Never invent a value that is not actually visible on the label — use',
      'null for any field you cannot read, rather than guessing. Do not',
      'include any text outside the JSON object.',
    ].join('\n');
  }

  private parseLabelPhotoResponse(llm: LlmResult): LabelAnalysisResult {
    const base: Pick<LabelAnalysisResult, 'provider' | 'cost' | 'durationMs'> = {
      provider: llm.provider,
      cost: llm.cost,
      durationMs: llm.durationMs,
    };
    try {
      const cleaned = this.extractJsonCandidate(llm.text);
      const parsed = JSON.parse(cleaned) as {
        productName?: string | null;
        brand?: string | null;
        category?: string | null;
        ingredients?: unknown;
        allergens?: unknown;
        nutrition?: unknown;
        healthFlags?: unknown;
        summary?: string | null;
      };

      const productName = this.shortString(parsed.productName ?? undefined);
      const nutritionPanel = this.parseNutritionPanel(parsed.nutrition);
      const result: LabelAnalysisResult = {
        ...base,
        productName,
        brand: this.shortString(parsed.brand ?? undefined),
        category: this.shortString(parsed.category ?? undefined),
        ingredients: this.stringArray(parsed.ingredients),
        allergens: this.stringArray(parsed.allergens),
        nutritionalInfo: nutritionPanel
          ? Object.fromEntries(
              Object.entries(nutritionPanel).filter(
                (entry): entry is [string, number] => typeof entry[1] === 'number',
              ),
            )
          : {},
        nutritionPanel,
        healthFlags: this.stringArray(parsed.healthFlags),
        summary: this.shortString(parsed.summary ?? undefined),
        // A vision-native read that got a name AND at least one nutrition
        // field is a strong result; name-only is still useful but weaker.
        confidence: productName ? (nutritionPanel ? 0.8 : 0.6) : 0.3,
      };
      if (llm.truncated) {
        result.warnings = ['AI service degraded — result may be incomplete'];
        result.confidence = Math.min(result.confidence, 0.3);
      }
      return result;
    } catch {
      return {
        ...base,
        confidence: 0,
        warnings: ['Could not parse photo analysis — try a clearer photo'],
      };
    }
  }

  /**
   * Validates the model's nutrition sub-object against the SAME Zod schema
   * (`NutritionPanelSchema`) the rest of the backend already uses as the
   * single source of truth for "is this nutrition value sane" — reusing
   * it here means one place defines what's a plausible value, instead of
   * a second, possibly-inconsistent set of bounds. Any individual field
   * that fails validation (a hallucinated/out-of-range value) is dropped
   * rather than discarding the whole nutrition result — a partially
   * useful read beats none.
   */
  private parseNutritionPanel(value: unknown): LabelAnalysisResult['nutritionPanel'] {
    if (value === null || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const candidate: Record<string, unknown> = {};
    const numericKeys = [
      'servingSize',
      'calories',
      'protein',
      'carbohydrates',
      'sugars',
      'fat',
      'saturatedFat',
      'transFat',
      'fiber',
      'sodium',
    ];
    for (const key of numericKeys) {
      const v = raw[key];
      if (typeof v === 'number' && Number.isFinite(v)) candidate[key] = v;
    }
    if (typeof raw.servingUnit === 'string' && raw.servingUnit.trim()) {
      candidate.servingUnit = raw.servingUnit.trim().slice(0, 10);
    }
    if (Object.keys(candidate).length === 0) return undefined;

    const parsed = NutritionPanelSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;

    // Partial validity: drop only the offending field(s), keep the rest —
    // safeParse's error tells us exactly which keys failed.
    const badKeys = new Set(parsed.error.issues.map((issue) => issue.path[0]));
    const filtered = Object.fromEntries(Object.entries(candidate).filter(([k]) => !badKeys.has(k)));
    if (Object.keys(filtered).length === 0) return undefined;
    const retry = NutritionPanelSchema.safeParse(filtered);
    return retry.success ? retry.data : undefined;
  }

  private stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 50);
  }

  private numberRecord(value: unknown): Record<string, number> {
    if (value === null || typeof value !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[k.slice(0, 50)] = n;
    }
    return out;
  }

  private buildSummaryPrompt(input: SummaryInput): string {
    const summary = JSON.stringify(input.summary ?? {});
    return [
      'You are an analyst writing a one-paragraph executive summary for a retail audit report.',
      'Be concrete: cite percentages, totals, and the most actionable finding.',
      'Avoid hyperbole. Avoid more than three sentences.',
      `Report type: ${input.reportType ?? 'general'}`,
      `Summary numbers (JSON): ${summary}`,
    ].join('\n');
  }

  private buildIngredientPrompt(slug: string, locale: string): string {
    return [
      `You are a dietary information assistant. Explain the ingredient "${slug}" in plain, non-alarmist language.`,
      `Respond in ${locale === 'en' ? 'English' : locale}.`,
      'Return strict JSON with these keys: title, summary, whatItIs, healthImpact, commonUses (array of strings), childSafetyNote (string or null).',
      'Keep "summary" under 200 characters. Keep all other fields under 500 characters.',
      'Do not include any text outside the JSON object.',
    ].join('\n');
  }

  private parseIngredientResponse(
    slug: string,
    locale: string,
    raw: string,
  ): Omit<IngredientExplanationResult, 'cached' | 'provider' | 'cost' | 'durationMs'> {
    const fallback = {
      slug,
      locale,
      title: this.titleCase(slug),
      summary: 'Information unavailable for this ingredient.',
      whatItIs: 'Not enough data to describe this ingredient yet.',
      healthImpact: 'Health impact information is not yet available.',
      commonUses: [] as string[],
    };
    try {
      const cleaned = this.extractJsonCandidate(raw);
      const parsed = JSON.parse(cleaned) as {
        title?: string;
        summary?: string;
        whatItIs?: string;
        healthImpact?: string;
        commonUses?: string[];
        childSafetyNote?: string | null;
      };
      return {
        slug,
        locale,
        title: this.shortString(parsed.title) ?? fallback.title,
        summary: this.shortString(parsed.summary) ?? fallback.summary,
        whatItIs: this.shortString(parsed.whatItIs) ?? fallback.whatItIs,
        healthImpact: this.shortString(parsed.healthImpact) ?? fallback.healthImpact,
        commonUses: Array.isArray(parsed.commonUses)
          ? parsed.commonUses.filter((s): s is string => typeof s === 'string').slice(0, 10)
          : [],
        childSafetyNote: this.shortString(parsed.childSafetyNote ?? undefined),
      };
    } catch {
      return fallback;
    }
  }

  /**
   * Extract a JSON candidate from a raw LLM response. `options.json` asks the
   * provider for native structured output, but not every model/credential
   * enforces `responseMimeType` — a live Gemini check returned prose-wrapped
   * JSON ("Here is the JSON: ```{...}```"). This is resilient to all three
   * shapes: pure JSON, a fenced ```json block, and JSON embedded in prose
   * (sliced from the first `{`/`[` to the matching last `}`/`]`).
   */
  private extractJsonCandidate(raw: string): string {
    let s = raw.trim();
    // Prefer the contents of a fenced block if one is present.
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) s = fenced[1].trim();
    // If it doesn't already start with a JSON token, slice out the widest
    // {...} / [...] span so leading/trailing prose is dropped.
    if (s[0] !== '{' && s[0] !== '[') {
      const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0);
      const ends = [s.lastIndexOf('}'), s.lastIndexOf(']')].filter((i) => i >= 0);
      if (starts.length && ends.length) {
        const start = Math.min(...starts);
        const end = Math.max(...ends);
        if (end > start) s = s.slice(start, end + 1);
      }
    }
    return s;
  }

  private shortString(s: string | null | undefined): string | undefined {
    if (typeof s !== 'string') return undefined;
    const t = s.trim();
    if (!t) return undefined;
    return t.slice(0, 1000);
  }

  private titleCase(slug: string): string {
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
