import { z } from 'zod';

/**
 * BE-43 — Request body for `POST /api/v1/referrals/apply`.
 *
 * The shape check accepts any non-empty string up to 32 characters so
 * the service layer can decide whether a malformed code is silently
 * rejected (mobile clients shouldn't surface a validation error for a
 * mistyped code — that's a user-experience footgun). Length is capped
 * to keep abuse logging bounded.
 */
export const ApplyReferralSchema = z.object({
  code: z.string().min(1, 'Referral code is required').max(32, 'Referral code is too long'),
});

export type ApplyReferralDto = z.infer<typeof ApplyReferralSchema>;
