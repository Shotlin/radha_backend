import { z } from 'zod';

/**
 * BE-35 — Activate Business DTO (Zod schema + inferred type).
 */
export const ActivateBusinessSchema = z.object({
  businessName: z
    .string()
    .min(1, 'Business name is required')
    .max(120, 'Business name must be 120 characters or fewer'),
  storeName: z
    .string()
    .min(1, 'Store name is required')
    .max(120, 'Store name must be 120 characters or fewer'),
  storeAddressLine1: z.string().max(255).optional(),
  storeCity: z.string().max(100).optional(),
  storeState: z.string().max(100).optional(),
  storePincode: z.string().max(10).optional(),
  preset: z.enum(['business_owner', 'pharmacy', 'institution']).optional(),
  acceptTrialPro: z.boolean(),
});

export type ActivateBusinessDto = z.infer<typeof ActivateBusinessSchema>;
