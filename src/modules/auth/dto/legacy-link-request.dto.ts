import { z } from 'zod';

export const LegacyLinkRequestSchema = z.object({
  mobile: z.string().min(10).max(20),
});

export type LegacyLinkRequestDto = z.infer<typeof LegacyLinkRequestSchema>;
