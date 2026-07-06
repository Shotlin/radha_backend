import { z } from 'zod';

/**
 * BE-36 — DTO for Premium Consumer subscription creation.
 *
 * The `paymentMethodToken` is the token received from the client after
 * the user completes UPI/card setup for RBI eMandate registration.
 */
export const PremiumSubscribeSchema = z.object({
  paymentMethodToken: z
    .string()
    .min(1, 'Payment method token is required')
    .max(512, 'Payment method token too long'),
});

export type PremiumSubscribeDto = z.infer<typeof PremiumSubscribeSchema>;
