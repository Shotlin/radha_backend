import { z } from 'zod';

/**
 * BE-36 — DTO for accepting a Family Sharing invite.
 *
 * The `inviteId` is the UUID of the pending invitation row
 * in `family_sharing_members`.
 */
export const FamilyAcceptSchema = z.object({
  inviteId: z.string().uuid('Invalid invite ID'),
});

export type FamilyAcceptDto = z.infer<typeof FamilyAcceptSchema>;
