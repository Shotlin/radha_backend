import { z } from 'zod';

import { SUPPORTED_LOCALES } from '@/common/i18n/types/locale.types';

/**
 * BE-42 — PUT /api/v1/users/me/language request body.
 *
 * Validated through `ZodValidationPipe`. The exported type is inferred
 * from the schema so the controller and the Mobile_App can rely on a
 * single source of truth.
 */
export const UpdateLanguageSchema = z
  .object({
    language: z.enum(SUPPORTED_LOCALES),
  })
  .strict();

export type UpdateLanguageDto = z.infer<typeof UpdateLanguageSchema>;

/**
 * Response body for PUT /users/me/language.
 *
 * Mirrors the saved value plus a `changed` flag so the client can
 * distinguish "we actually rewrote the row" from "no-op, already
 * the same value". Useful for analytics and for the Mobile_App
 * flash-message logic.
 */
export interface UpdateLanguageResponseDto {
  preferredLanguage: string;
  changed: boolean;
}
