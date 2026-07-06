import { z } from 'zod';

/**
 * BE-36 — DTO for Family Sharing invite.
 *
 * `mobile` is the Indian mobile number of the family member to invite.
 * Must be a valid 10-digit number (optionally prefixed with +91).
 */
export const FamilyInviteSchema = z.object({
  mobile: z
    .string()
    .regex(/^(\+91)?[6-9]\d{9}$/, 'Invalid Indian mobile number')
    .transform((v) => (v.startsWith('+91') ? v : `+91${v}`)),
});

export type FamilyInviteDto = z.infer<typeof FamilyInviteSchema>;

/**
 * BE-36 — DTO for accepting a Family Sharing invite.
 */
export const FamilyAcceptSchema = z.object({
  inviteId: z.string().uuid('Invalid invite ID'),
});

export type FamilyAcceptDto = z.infer<typeof FamilyAcceptSchema>;
