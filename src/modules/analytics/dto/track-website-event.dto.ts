import { z } from 'zod';

/**
 * BE-29 — Public website event payload.
 *
 * Strict (`forbidNonWhitelisted` semantics via `.strict()`) so any
 * field not in the schema is rejected — keeps the analytics surface
 * from accidentally accepting random PII the marketing site wants to
 * push.
 */

export const WebsiteEventTypeSchema = z.enum([
  'page_view',
  'button_click',
  'pricing_view',
  'demo_click',
  'contact_click',
  'whatsapp_click',
  'app_download_click',
  'feature_view',
  'scroll_depth',
  'video_play',
  'form_submit',
]);

const NonEmptyShortString = (max: number) => z.string().trim().min(1).max(max);

export const TrackWebsiteEventSchema = z
  .object({
    type: WebsiteEventTypeSchema,
    page: NonEmptyShortString(500).optional(),
    pageTitle: NonEmptyShortString(200).optional(),
    referrer: NonEmptyShortString(500).optional(),

    utmSource: NonEmptyShortString(100).optional(),
    utmMedium: NonEmptyShortString(100).optional(),
    utmCampaign: NonEmptyShortString(200).optional(),
    utmTerm: NonEmptyShortString(200).optional(),
    utmContent: NonEmptyShortString(200).optional(),

    userAgent: z.string().max(500).optional(),
    browser: NonEmptyShortString(50).optional(),
    os: NonEmptyShortString(50).optional(),
    device: NonEmptyShortString(30).optional(),

    /** ISO-3166 alpha-2 (uppercase). */
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO code')
      .transform((v) => v.toUpperCase())
      .optional(),

    sessionId: NonEmptyShortString(64),
    /** Caller-side anonymous ID. The server hashes this before persist. */
    visitorId: NonEmptyShortString(128).optional(),

    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type TrackWebsiteEventDto = z.infer<typeof TrackWebsiteEventSchema>;
