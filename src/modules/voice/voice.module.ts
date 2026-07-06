import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { VoicePlaceholderController } from './controllers/voice-placeholder.controller';

/**
 * BE-57 — Voice Features Deferral Marker.
 *
 * Per Req 36, voice features are formally excluded from v1 and any
 * future implementation must sit behind the `voice_features_v2`
 * feature flag (see `docs/roadmap/voice-features-v2.md`).
 *
 * This module reserves the `/api/v1/voice/*` namespace by mounting
 * a single placeholder controller that responds with HTTP 503 and a
 * machine-readable `FEATURE_NOT_AVAILABLE` envelope. v2 will replace
 * the placeholder with real controllers without renaming the route.
 *
 * Imports:
 *   - `AuthModule` → `JwtAuthGuard`. Even though the route is a hard
 *     503, we still demand a valid JWT so the deferral marker behaves
 *     consistently with every other authenticated namespace and so
 *     unauthenticated clients don't probe the surface.
 *
 * Per the BE-57 brief, this module is NOT registered in
 * `app.module.ts` — that wiring step lives in the BE-57 handoff doc.
 */
@Module({
  imports: [AuthModule],
  controllers: [VoicePlaceholderController],
})
export class VoiceModule {}
