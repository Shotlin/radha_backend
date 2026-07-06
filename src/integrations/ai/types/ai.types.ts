/**
 * BE-22 — AI/OCR wrapper public types.
 *
 * The orchestrator, providers, and downstream consumers (BE-40
 * ingredient explainer, BE-45 image fallback) all consume these
 * types. Keep them isomorphic — no Node-only imports — so they can
 * graduate to `` if mobile ever needs the same
 * envelope.
 */

export type AiProvider =
  | 'mlkit'
  | 'rekognition'
  | 'google-vision'
  | 'openai'
  | 'gemini'
  | 'nvidia'
  | 'claude'
  | 'openfoodfacts'
  | 'mock';

export type AiOperation =
  | 'ocr-expiry'
  | 'ocr-batch'
  | 'ocr-text'
  | 'label-analysis'
  | 'image-fallback'
  | 'report-summary'
  | 'product-enrichment'
  | 'image-classification'
  | 'ingredient-explanation';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface ExtractedDate {
  raw: string;
  parsed: Date;
  format: string;
  confidence: number;
}

export interface ExtractedFields {
  dates?: ExtractedDate[];
  numbers?: string[];
  productCodes?: string[];
  text?: string;
}

export interface OcrOptions {
  preferredProvider?: AiProvider;
  fallbackToPaid?: boolean;
  language?: string;
  confidenceThreshold?: number;
  patterns?: RegExp[];
  /** Mobile-side OCR text already extracted by Google ML Kit. */
  preExtractedText?: string;
  /** Confidence reported by ML Kit (0–1). */
  preExtractedConfidence?: number;
}

export interface OcrResult {
  success: boolean;
  text: string;
  extractedData?: ExtractedFields;
  confidence: number;
  provider: AiProvider;
  cost: number;
  durationMs: number;
  warnings?: string[];
}

export interface LabelAnalysisResult {
  productName?: string;
  brand?: string;
  category?: string;
  ingredients?: string[];
  allergens?: string[];
  nutritionalInfo?: Record<string, number>;
  /**
   * Plain-language, non-alarmist health summary. Populated by the
   * text-transcript analysis path (on-device OCR → Gemini) that backs the
   * consumer "scan the label" fallback when a barcode lookup misses.
   */
  summary?: string;
  /** Short health concern/flag chips, e.g. "high sugar", "ultra-processed". */
  healthFlags?: string[];
  confidence: number;
  provider: AiProvider;
  cost: number;
  durationMs: number;
  warnings?: string[];
}

export interface ImageFallbackResult {
  /** Best-guess EAN if a barcode was detected directly. */
  ean?: string;
  /** Up to N candidate products inferred from text+labels. */
  candidates: ImageFallbackCandidate[];
  /** OCR text used for the inference, surfaced for client debug. */
  ocrText?: string;
  confidence: number;
  provider: AiProvider;
  cost: number;
  durationMs: number;
}

export interface ImageFallbackCandidate {
  productName: string;
  brand?: string;
  ean?: string;
  confidence: number;
  source: 'ocr' | 'label' | 'logo';
}

export interface LlmOptions {
  maxTokens?: number;
  temperature?: number;
  provider?: 'openai' | 'claude' | 'mock';
  /** Hard wall-clock cap; 10 s default per Req 45 / T-v2.3. */
  timeoutMs?: number;
  locale?: string;
  /**
   * Request native structured output. When set, a provider that supports it
   * (Gemini) constrains the model to emit a single parseable JSON object
   * (`responseMimeType: application/json`), removing the markdown-fence /
   * prose-leak fragility of prompt-only "STRICT JSON" requests. Providers that
   * don't support it ignore the flag — callers must keep tolerant parsers.
   */
  json?: boolean;
  /**
   * Per-call model routing override (e.g. a heavier model for a harder task).
   * Falls back to the provider's env-configured default when unset.
   */
  model?: string;
}

export interface LlmResult {
  text: string;
  tokensUsed: number;
  cost: number;
  provider: AiProvider;
  durationMs: number;
  truncated?: boolean;
}

export interface IngredientExplanationResult {
  slug: string;
  title: string;
  summary: string;
  whatItIs: string;
  healthImpact: string;
  commonUses: string[];
  childSafetyNote?: string;
  locale: string;
  cached: boolean;
  provider: AiProvider;
  cost: number;
  durationMs: number;
}

export interface UsageStats {
  tenantId: string;
  period: DateRange;
  byOperation: Partial<
    Record<
      AiOperation,
      {
        count: number;
        successCount: number;
        failureCount: number;
        totalCost: number;
        totalTokens: number;
        avgDurationMs: number;
      }
    >
  >;
  byProvider: Partial<
    Record<
      AiProvider,
      {
        count: number;
        totalCost: number;
        totalTokens: number;
      }
    >
  >;
  totalCost: number;
  totalCalls: number;
  totalTokens: number;
}

export interface AiUsageRecord {
  tenantId: string;
  userId?: string;
  operation: AiOperation;
  provider: AiProvider;
  cost: number;
  durationMs: number;
  tokensUsed?: number;
  success: boolean;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface LimitCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetAt: Date;
  reason?: string;
}

export interface OperationLimits {
  monthly: number;
  daily?: number;
}

/** Provider abstractions consumed by the orchestrator + downstream phases. */

export interface IOcrProvider {
  readonly name: AiProvider;
  /** Return null when the provider is not configured / disabled. */
  extractText(buffer: Buffer, options?: OcrOptions): Promise<OcrResult>;
}

/** Used by BE-45 (`POST /api/v1/scan/image-fallback`). */
export interface IImageRecognitionProvider {
  readonly name: AiProvider;
  recognise(buffer: Buffer): Promise<ImageFallbackResult>;
  analyseLabel(buffer: Buffer): Promise<LabelAnalysisResult>;
}

/** Used by BE-40 (`GET /api/v1/ingredients/:slug/explanation`) and report summaries. */
export interface ILlmProvider {
  readonly name: AiProvider;
  /** Generic completion. Implementations must respect `options.timeoutMs`. */
  complete(prompt: string, options?: LlmOptions): Promise<LlmResult>;
  isConfigured(): boolean;
}

export interface IAiOrchestratorService {
  extractExpiryDate(mediaId: string, options?: OcrOptions): Promise<OcrResult>;
  extractBatchNumber(mediaId: string, options?: OcrOptions): Promise<OcrResult>;
  extractText(mediaId: string, options?: OcrOptions): Promise<OcrResult>;
  analyzeProductLabel(mediaId: string): Promise<LabelAnalysisResult>;
  analyzeLabelText(transcript: string, options?: LlmOptions): Promise<LabelAnalysisResult>;
  imageFallbackScan(mediaId: string): Promise<ImageFallbackResult>;
  generateReportSummary(reportData: unknown, options?: LlmOptions): Promise<LlmResult>;
  explainIngredient(slug: string, options?: LlmOptions): Promise<IngredientExplanationResult>;
  getUsage(tenantId: string, dateRange: DateRange): Promise<UsageStats>;
  getEstimatedCost(operation: AiOperation, count: number): number;
}

export interface IUsageTrackerService {
  trackUsage(record: AiUsageRecord): Promise<void>;
  checkLimit(tenantId: string, operation: AiOperation): Promise<LimitCheckResult>;
  getUsageForTenant(tenantId: string, dateRange: DateRange): Promise<UsageStats>;
  getCostBreakdown(tenantId: string, dateRange: DateRange): Promise<UsageStats>;
}

export interface IOcrParser {
  extractDates(text: string): ExtractedDate[];
  extractNumbers(text: string, pattern?: RegExp): string[];
  extractEans(text: string): string[];
}

/** Token used to inject the active LLM provider through Nest's DI. */
export const LLM_PROVIDER_TOKEN = Symbol('AI_LLM_PROVIDER');
/** Token used to inject the active image-recognition provider. */
export const IMAGE_RECOGNITION_PROVIDER_TOKEN = Symbol('AI_IMAGE_RECOGNITION_PROVIDER');
/** Token used to inject the active server-side OCR provider. */
export const OCR_PROVIDER_TOKEN = Symbol('AI_OCR_PROVIDER');
