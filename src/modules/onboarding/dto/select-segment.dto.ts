import { z } from 'zod';

import { ONBOARDING_SEGMENTS } from '../types/segment.enum';

/**
 * BE-34 — Request DTO for POST /api/v1/onboarding/segment.
 *
 * Validated via ZodValidationPipe in the controller.
 */
export const SelectSegmentSchema = z.object({
  segment: z.enum(ONBOARDING_SEGMENTS),
});

export type SelectSegmentDto = z.infer<typeof SelectSegmentSchema>;
