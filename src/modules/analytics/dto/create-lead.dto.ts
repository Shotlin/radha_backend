import { z } from 'zod';

/**
 * BE-29 — Public lead capture payload.
 *
 * Strict + length caps so a hostile form post can't drown the table
 * in megabyte-sized strings.
 */

export const LeadSourceSchema = z.enum([
  'contact_form',
  'demo_request',
  'whatsapp',
  'phone',
  'email',
  'referral',
  'other',
]);

const IndianMobileRe = /^(\+?91[-\s]?)?[6-9]\d{9}$/;

export const CreateLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(255),
    mobile: z
      .string()
      .trim()
      .max(20)
      .refine((v) => IndianMobileRe.test(v.replace(/\s/g, '')), {
        message: 'mobile must be a valid Indian mobile number',
      })
      .optional(),
    company: z.string().trim().max(200).optional(),
    message: z.string().trim().max(2000).optional(),

    source: LeadSourceSchema,

    utmSource: z.string().trim().max(100).optional(),
    utmMedium: z.string().trim().max(100).optional(),
    utmCampaign: z.string().trim().max(200).optional(),

    pageUrl: z.string().trim().url().max(500).optional(),
    referrer: z.string().trim().max(500).optional(),

    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CreateLeadDto = z.infer<typeof CreateLeadSchema>;
