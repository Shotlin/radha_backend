import { z } from 'zod';

/**
 * BE-55 — `POST /api/v1/shopping-lists/:id/whatsapp-format` request body.
 *
 * The body is intentionally optional. The default behaviour is to
 * include both purchased and unpurchased items because that's the
 * useful "share my whole list" flow; clients can opt out by sending
 * `{ "includePurchased": false }`.
 *
 * `phone` is an optional E.164-style number. When provided the
 * generated `wa.me` URL targets that contact directly; when omitted
 * the URL drops the recipient segment so WhatsApp prompts the user
 * to pick from their address book.
 */
export const WhatsAppFormatSchema = z
  .object({
    includePurchased: z.boolean().optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{6,14}$/, 'phone must be in E.164 format')
      .optional(),
  })
  .strict()
  .optional();

export type WhatsAppFormatDto = z.infer<typeof WhatsAppFormatSchema>;

/**
 * Response body for the WhatsApp formatter endpoint. Returned as the
 * literal JSON shape `{ text: '...', shareUrl: '...' }` per the BE-55
 * spec.
 */
export interface WhatsAppFormatResponseDto {
  /** Pre-formatted multi-line text the user (or app) can copy. */
  text: string;
  /** `https://wa.me/...` deep link with the text URL-encoded into `?text=`. */
  shareUrl: string;
}
