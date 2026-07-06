import { z } from 'zod';

import { GST_REGEX, INDIAN_MOBILE_REGEX, PAN_REGEX, PINCODE_REGEX } from './create-supplier.dto';

/**
 * BE-25 — Patch-style update DTO. Every field optional; the service
 * layer rejects empty payloads.
 *
 * Status changes have their own dedicated endpoints (activate /
 * deactivate / blacklist) so they're intentionally NOT part of the
 * generic update surface.
 */

const PhoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^[+0-9 \-()]+$/, 'Phone may contain digits, spaces, and + - ( ) only');

export const UpdateSupplierSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    legalName: z.string().max(200).nullable().optional(),
    gstNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(GST_REGEX, 'Invalid GST number format')
      .nullable()
      .optional(),
    panNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(PAN_REGEX, 'Invalid PAN format')
      .nullable()
      .optional(),
    category: z.string().max(100).nullable().optional(),
    description: z.string().max(1000).nullable().optional(),

    email: z.string().email().max(255).nullable().optional(),
    phone: PhoneSchema.nullable().optional(),
    alternatePhone: PhoneSchema.nullable().optional(),
    whatsappNumber: z
      .string()
      .trim()
      .regex(INDIAN_MOBILE_REGEX, 'Indian mobile numbers must be 10 digits starting 6-9')
      .nullable()
      .optional(),

    addressLine1: z.string().max(255).nullable().optional(),
    addressLine2: z.string().max(255).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(100).nullable().optional(),
    pincode: z.string().regex(PINCODE_REGEX, 'pincode must be 6 digits').nullable().optional(),
    country: z.string().length(2).optional(),

    paymentTerms: z.string().max(100).nullable().optional(),
    deliveryDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
    minimumOrderAmount: z.coerce.number().min(0).max(99_999_999.99).nullable().optional(),

    metadata: z.record(z.unknown()).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'update payload must have at least one field',
  });
export type UpdateSupplierDto = z.infer<typeof UpdateSupplierSchema>;

export const BlacklistSupplierSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type BlacklistSupplierDto = z.infer<typeof BlacklistSupplierSchema>;
