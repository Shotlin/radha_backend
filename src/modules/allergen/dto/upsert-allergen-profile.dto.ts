import { z } from 'zod';

import { ageBandValues } from '@/db/schema/allergen-profiles';

/**
 * BE-37 — Upsert allergen profile DTO.
 *
 * When `id` is present the operation is an update; otherwise it's a create.
 * `displayName` is stored encrypted — only the plaintext is accepted here.
 */
export const UpsertAllergenProfileSchema = z.object({
  id: z.string().uuid().optional(),
  familyMemberUserId: z.string().uuid().optional().nullable(),
  displayName: z.string().min(1).max(100),
  ageBand: z.enum(ageBandValues),
  allergyTags: z.array(z.string().min(1).max(50)).max(50).default([]),
  conditionTags: z.array(z.string().min(1).max(50)).max(30).default([]),
});

export type UpsertAllergenProfileDto = z.infer<typeof UpsertAllergenProfileSchema>;
