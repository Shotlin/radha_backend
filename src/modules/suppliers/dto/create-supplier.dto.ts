import { z } from 'zod';

/**
 * BE-25 — Create-supplier DTO.
 *
 * GST + PAN are optional but, when supplied, MUST match the
 * canonical Indian formats. The same regexes are mirrored in the
 * service layer so a malformed value coming from a non-DTO entry
 * point (e.g. bulk import) still gets rejected cleanly.
 *
 * The contact list is supplied here in addition to (and not instead
 * of) the per-supplier primary `email` / `phone` fields — most
 * suppliers populate the primary fields directly and only larger
 * vendors need the multi-contact list. The service moves the first
 * primary contact into the supplier columns when none is set.
 */

export const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
export const PINCODE_REGEX = /^\d{6}$/;
export const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

const PhoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^[+0-9 \-()]+$/, 'Phone may contain digits, spaces, and + - ( ) only');

export const ContactSchema = z.object({
  name: trimmed(100),
  designation: z.string().max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: PhoneSchema.optional(),
  isPrimary: z.boolean().optional().default(false),
  notes: z.string().max(500).optional(),
});
export type ContactDto = z.infer<typeof ContactSchema>;

export const CreateSupplierSchema = z.object({
  name: trimmed(200),
  legalName: z.string().max(200).optional(),
  /** Auto-generated when omitted (`SUP-<NAME>-<EPOCH>` shape). */
  code: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/, 'code must be uppercase alphanumeric/_/-')
    .optional(),

  gstNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GST_REGEX, 'Invalid GST number format')
    .optional(),
  panNumber: z.string().trim().toUpperCase().regex(PAN_REGEX, 'Invalid PAN format').optional(),

  category: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),

  // Primary contact (denormalised onto the supplier row)
  email: z.string().email().max(255).optional(),
  phone: PhoneSchema.optional(),
  alternatePhone: PhoneSchema.optional(),
  whatsappNumber: z
    .string()
    .trim()
    .regex(INDIAN_MOBILE_REGEX, 'Indian mobile numbers must be 10 digits starting 6-9')
    .optional(),

  // Address
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: z.string().regex(PINCODE_REGEX, 'pincode must be 6 digits').optional(),
  country: z.string().length(2).default('IN'),

  // Business terms
  paymentTerms: z.string().max(100).optional(),
  deliveryDays: z.coerce.number().int().min(0).max(365).optional(),
  minimumOrderAmount: z.coerce.number().min(0).max(99_999_999.99).optional(),

  // Optional contacts list
  contacts: z.array(ContactSchema).max(20).optional(),

  metadata: z.record(z.unknown()).optional(),
});
export type CreateSupplierDto = z.infer<typeof CreateSupplierSchema>;

export const AddContactSchema = ContactSchema;
export type AddContactDto = z.infer<typeof AddContactSchema>;
