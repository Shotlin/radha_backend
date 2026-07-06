/**
 * BE-42 — Supported locales for the RADHA backend.
 *
 * Mobile_App and Backend speak the same six languages (Req 34):
 * English (default), Hindi, Tamil, Telugu, Bengali, Marathi.
 *
 * `SUPPORTED_LOCALES` is the runtime source of truth — both the
 * Zod schema (`UpdateLanguageDto`) and the middleware (`Accept-Language`
 * parser) consume it directly so adding a 7th locale is a single
 * edit + a new JSON file.
 */
export const SUPPORTED_LOCALES = ['en', 'hi', 'ta', 'te', 'bn', 'mr'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Default locale used when no `Accept-Language` header is present
 * or the requested language is not in `SUPPORTED_LOCALES`.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * Type-guard for runtime values (header parsing, request bodies).
 */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
