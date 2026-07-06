import { SetMetadata } from '@nestjs/common';

/**
 * BE-47 — Reflection metadata key used by `FeatureFlagGuard` to look
 * up the flag a handler requires.
 */
export const FEATURE_FLAG_KEY = 'feature-flag:requireFlag';

/**
 * Gate a controller method (or class) behind a feature flag.
 *
 * Usage:
 * ```ts
 * @Controller('voice')
 * @UseGuards(JwtAuthGuard, FeatureFlagGuard)
 * export class VoiceController {
 *   @Post('start')
 *   @RequireFeatureFlag('voice_v2')
 *   start() { ... }
 * }
 * ```
 *
 * The guard reads the metadata via `Reflector`, asks
 * `FeatureFlagsService.isEnabled(flag, req.user)`, and rejects with
 * `404 NOT_FOUND` (not 403) when the flag is off — the same way
 * GitHub hides flag-gated endpoints. We intentionally do not leak
 * "flag X is off" to non-authenticated clients.
 */
export const RequireFeatureFlag = (flagName: string): MethodDecorator & ClassDecorator =>
  SetMetadata(FEATURE_FLAG_KEY, flagName);
