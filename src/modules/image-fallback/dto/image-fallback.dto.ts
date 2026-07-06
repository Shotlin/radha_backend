import { z } from 'zod';

/**
 * BE-45 — Request/response DTOs for the image OCR scan fallback.
 *
 * Per Req 38, the Mobile_App invokes this endpoint when a barcode
 * can't be decoded within 2 seconds. The body carries the S3 object
 * key the camera image was uploaded to (via the BE-13 presigned URL
 * flow) plus an optional locale hint for OCR.
 */

/** Locales accepted by the Vision OCR provider — mirrors the i18n manifest. */
export const SUPPORTED_FALLBACK_LOCALES = ['en', 'hi', 'ta', 'te', 'bn', 'mr'] as const;
export type SupportedFallbackLocale = (typeof SUPPORTED_FALLBACK_LOCALES)[number];
export const DEFAULT_FALLBACK_LOCALE: SupportedFallbackLocale = 'en';

/**
 * S3 object keys we accept always start with the BE-13 prefix
 * (`uploads/`, `media/`, etc.) and never start with a slash. We keep
 * the regex permissive — the real ACL check is the presigned URL
 * grant — but block obviously malformed values like blank strings,
 * absolute paths, and traversal segments.
 */
const S3_KEY_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9._\-/]*[a-zA-Z0-9])?$/;

export const ImageFallbackSchema = z
  .object({
    s3ObjectKey: z
      .string()
      .trim()
      .min(1, 's3ObjectKey is required')
      .max(1024, 's3ObjectKey too long')
      .regex(S3_KEY_REGEX, 's3ObjectKey contains invalid characters')
      .refine((val) => !val.includes('..'), {
        message: 's3ObjectKey must not contain ".." segments',
      }),
    locale: z
      .string()
      .trim()
      .min(1)
      .max(8)
      .optional()
      .transform((v) => (v === undefined ? undefined : v.toLowerCase())),
  })
  .strict();

export type ImageFallbackDto = z.infer<typeof ImageFallbackSchema>;

/** The single response envelope every fallback call resolves to. */
export interface ImageFallbackResponseDto {
  matched: boolean;
  ean?: string;
  productName?: string;
  brand?: string;
  source: 'catalog' | 'off' | 'none';
  costPaise?: number;
}

/** Resolve a raw locale string to a supported locale, defaulting to `en`. */
export function resolveFallbackLocale(
  raw: string | null | undefined,
): SupportedFallbackLocale {
  if (!raw) return DEFAULT_FALLBACK_LOCALE;
  const lower = raw.toLowerCase().trim();
  return (SUPPORTED_FALLBACK_LOCALES as readonly string[]).includes(lower)
    ? (lower as SupportedFallbackLocale)
    : DEFAULT_FALLBACK_LOCALE;
}
