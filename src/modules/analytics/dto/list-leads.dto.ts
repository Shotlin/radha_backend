import { z } from 'zod';

import { LeadSourceSchema } from './create-lead.dto';
import { LeadStatusSchema } from './update-lead.dto';

/**
 * BE-29 — Paginated lead listing query.
 */

export const ListLeadsQuerySchema = z
  .object({
    status: LeadStatusSchema.optional(),
    source: LeadSourceSchema.optional(),
    utmCampaign: z.string().trim().max(200).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ListLeadsQueryDto = z.infer<typeof ListLeadsQuerySchema>;
