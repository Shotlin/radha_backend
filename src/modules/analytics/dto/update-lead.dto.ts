import { z } from 'zod';

/**
 * BE-29 — Authenticated lead update payload.
 */

export const LeadStatusSchema = z.enum([
  'new',
  'contacted',
  'qualified',
  'demo_scheduled',
  'demo_completed',
  'converted',
  'lost',
  'spam',
]);

export const UpdateLeadSchema = z
  .object({
    status: LeadStatusSchema,
    notes: z.string().trim().max(2000).optional(),
    assignedTo: z.string().uuid().optional(),
    lostReason: z.string().trim().max(500).optional(),
  })
  .strict();

export type UpdateLeadDto = z.infer<typeof UpdateLeadSchema>;

export const ConvertLeadSchema = z
  .object({
    tenantId: z.string().uuid(),
  })
  .strict();

export type ConvertLeadDto = z.infer<typeof ConvertLeadSchema>;
