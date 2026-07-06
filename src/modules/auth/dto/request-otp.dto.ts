import { z } from 'zod';

/**
 * Strict validation runs in two layers — Zod (shape) here, mobile
 * normalisation in `mobile.utils.ts`. We accept any string that can
 * be normalised to a valid Indian mobile so the user can paste
 * "+91 98765 43210" without re-formatting.
 */
export const RequestOtpSchema = z.object({
  mobile: z.string().min(10).max(20),
  deviceId: z.string().min(1).max(255).optional(),
  platform: z.enum(['mobile', 'web', 'admin']).default('mobile'),
});

export type RequestOtpDto = z.infer<typeof RequestOtpSchema>;
