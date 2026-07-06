import { z } from 'zod';

/**
 * BE-22 — Consolidated Zod schemas for the AI/OCR REST surface.
 *
 * One file, multiple schemas, mirrors the BE-15/16/17/18 convention
 * (`<feature>.dto.ts`). Caps and lengths are tuned to the storage
 * column sizes in `db/schema/ai.ts` so we never hit a "value too long"
 * surprise at the DB layer.
 */

const UUID = z.string().uuid({ message: 'must be a UUID' });

const PRE_EXTRACTED_TEXT_MAX = 5_000;
const SUMMARY_DATA_MAX_BYTES = 32 * 1024;
const INGREDIENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

/* ─────────────────── OCR ─────────────────── */

export const OcrRequestSchema = z
  .object({
    mediaId: UUID,
    preExtractedText: z
      .string()
      .max(PRE_EXTRACTED_TEXT_MAX, `must be ≤ ${PRE_EXTRACTED_TEXT_MAX} characters`)
      .optional(),
    preExtractedConfidence: z.number().min(0).max(1).optional(),
    fallbackToPaid: z.boolean().optional().default(false),
    language: z.string().regex(LOCALE_RE, 'invalid locale').optional().default('en'),
  })
  .strict();
export type OcrRequestDto = z.infer<typeof OcrRequestSchema>;

/* ─────────────────── Label / image fallback ─────────────────── */

export const LabelAnalyzeRequestSchema = z
  .object({
    mediaId: UUID,
  })
  .strict();
export type LabelAnalyzeRequestDto = z.infer<typeof LabelAnalyzeRequestSchema>;

export const ImageFallbackRequestSchema = z
  .object({
    mediaId: UUID,
  })
  .strict();
export type ImageFallbackRequestDto = z.infer<typeof ImageFallbackRequestSchema>;

/**
 * Text-transcript label analysis — the consumer "scan the label" fallback.
 * The mobile sends an on-device OCR transcript (not an image), which the LLM
 * parses into a structured product analysis.
 */
export const LabelTextAnalyzeRequestSchema = z
  .object({
    transcript: z
      .string()
      .trim()
      .min(1, 'transcript is required')
      .max(PRE_EXTRACTED_TEXT_MAX, `must be ≤ ${PRE_EXTRACTED_TEXT_MAX} characters`),
    locale: z.string().regex(LOCALE_RE, 'invalid locale').optional().default('en'),
  })
  .strict();
export type LabelTextAnalyzeRequestDto = z.infer<typeof LabelTextAnalyzeRequestSchema>;

/* ─────────────────── Report summary ─────────────────── */

export const ReportSummaryRequestSchema = z
  .object({
    reportType: z.string().min(1).max(64).optional(),
    storeId: UUID.optional(),
    summary: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    data: z.unknown().optional(),
  })
  .strict()
  .refine(
    (val) => Buffer.byteLength(JSON.stringify(val)) <= SUMMARY_DATA_MAX_BYTES,
    `payload must be ≤ ${SUMMARY_DATA_MAX_BYTES} bytes`,
  );
export type ReportSummaryRequestDto = z.infer<typeof ReportSummaryRequestSchema>;

/* ─────────────────── Ingredient explanation ─────────────────── */

export const IngredientExplanationQuerySchema = z
  .object({
    locale: z.string().regex(LOCALE_RE, 'invalid locale').optional().default('en'),
  })
  .strict();
export type IngredientExplanationQueryDto = z.infer<typeof IngredientExplanationQuerySchema>;

export const IngredientSlugSchema = z
  .string()
  .regex(
    INGREDIENT_SLUG_RE,
    'invalid ingredient slug — lowercase letters, digits, hyphens, max 100 chars',
  );

/* ─────────────────── Usage / limits ─────────────────── */

export const UsageQuerySchema = z
  .object({
    from: z.string().datetime({ message: 'must be ISO-8601' }).optional(),
    to: z.string().datetime({ message: 'must be ISO-8601' }).optional(),
  })
  .strict()
  .refine((val) => {
    if (val.from && val.to) {
      return new Date(val.from).getTime() <= new Date(val.to).getTime();
    }
    return true;
  }, '`from` must be earlier than or equal to `to`');
export type UsageQueryDto = z.infer<typeof UsageQuerySchema>;

export const LimitCheckQuerySchema = z
  .object({
    operation: z.enum([
      'ocr-expiry',
      'ocr-batch',
      'ocr-text',
      'label-analysis',
      'image-fallback',
      'report-summary',
      'product-enrichment',
      'image-classification',
      'ingredient-explanation',
    ]),
  })
  .strict();
export type LimitCheckQueryDto = z.infer<typeof LimitCheckQuerySchema>;
