import { z } from 'zod';

/**
 * `POST /api/v1/voice/assistant/turn` request body.
 *
 * The app never sends `x-store-id` (`dio_provider.dart` only sets
 * Content-Type/Accept — confirmed by grep), so `storeId` travels here in
 * the body and the service asserts it against `AuthenticatedUser.storeIds`
 * before any query — the caller's claimed store is never trusted blindly.
 */
export const VoiceTurnRequestSchema = z
  .object({
    storeId: z.string().uuid(),
    // Required for 'ask', optional (and ignored) for 'daily_summary' —
    // enforced by the refine() below rather than a conditional schema, so
    // the inferred type stays a single flat shape.
    transcript: z.string().trim().min(1).max(400).optional(),
    intent: z.enum(['ask', 'daily_summary']).default('ask'),
    locale: z.enum(['en', 'hi']).default('en'),
  })
  .strict()
  .refine((v) => v.intent === 'daily_summary' || !!v.transcript, {
    message: 'transcript is required when intent is "ask"',
    path: ['transcript'],
  });
export type VoiceTurnRequestDto = z.infer<typeof VoiceTurnRequestSchema>;
