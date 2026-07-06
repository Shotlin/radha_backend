import { All, Controller, ServiceUnavailableException, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

/**
 * BE-57 — Voice features deferral marker.
 *
 * Reserves the `/voice/*` namespace (mounted under the global
 * `/api/v1` prefix in `main.api.ts`) so that any client probing for
 * v2 voice endpoints receives a deterministic, machine-readable
 * "feature not available" response instead of a 404.
 *
 * Behaviour:
 *   - Every HTTP method on every sub-path resolves to a single
 *     handler that throws `ServiceUnavailableException` with a
 *     structured payload carrying:
 *       - `code: 'FEATURE_NOT_AVAILABLE'` — clients pivot off this
 *         constant (e.g. to render a "coming in v2" banner).
 *       - `feature: 'voice_features_v2'` — matches the feature flag
 *         that will gate v2 once implementation lands.
 *       - `message` — human-readable reason.
 *   - `JwtAuthGuard` is applied at the class level, identical to
 *     the rest of the authenticated surface, so unauthenticated
 *     probes 401 before they ever see the 503.
 *
 * When BE-XX (v2 voice) lands, replace this controller with the real
 * controllers and gate them on the `voice_features_v2` flag.
 */
@Controller('voice')
@UseGuards(JwtAuthGuard)
export class VoicePlaceholderController {
  @All('*')
  notAvailable(): never {
    throw new ServiceUnavailableException({
      code: 'FEATURE_NOT_AVAILABLE',
      message: 'Voice features available in v2 — currently disabled.',
      feature: 'voice_features_v2',
    });
  }
}
