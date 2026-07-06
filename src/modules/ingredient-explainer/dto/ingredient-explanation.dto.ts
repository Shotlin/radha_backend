import { z } from 'zod';

/**
 * BE-40 — Request/response DTOs for the ingredient explainer surface.
 *
 * Schemas validated through `ZodValidationPipe`. The supported locale
 * list mirrors the i18n manifest (BE-42); unsupported locales fall
 * back to `en` rather than 4xx-ing the client.
 */

export const SUPPORTED_LOCALES = ['en', 'hi', 'ta', 'te', 'bn', 'mr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const IngredientExplanationConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type IngredientExplanationConfidence = z.infer<typeof IngredientExplanationConfidenceSchema>;

/**
 * Query schema for `GET /api/v1/ingredients/:slug/explanation`.
 *
 * `locale` is optional; missing or unsupported values resolve to `en`
 * inside the service rather than failing validation here. We keep the
 * schema permissive so an out-of-date Mobile_App build never breaks.
 */
export const IngredientExplanationQuerySchema = z
  .object({
    locale: z.string().trim().min(1).max(8).optional(),
  })
  .strict();

export type IngredientExplanationQueryDto = z.infer<typeof IngredientExplanationQuerySchema>;

export interface IngredientExplanationDto {
  ingredientSlug: string;
  description: string;
  healthConsiderations: string;
  confidence: IngredientExplanationConfidence;
  language: SupportedLocale;
  generatedBy?: string;
  generatedAt?: string;
  cached: boolean;
}

/** Resolve a raw locale string to a supported locale, defaulting to `en`. */
export function resolveLocale(raw: string | null | undefined): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE;
  const lower = raw.toLowerCase().trim();
  return (SUPPORTED_LOCALES as readonly string[]).includes(lower)
    ? (lower as SupportedLocale)
    : DEFAULT_LOCALE;
}
