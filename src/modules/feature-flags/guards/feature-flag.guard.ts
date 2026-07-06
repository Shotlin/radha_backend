import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { FEATURE_FLAG_KEY } from '../decorators/feature-flag.decorator';
import { FeatureFlagsService } from '../services/feature-flags.service';
import { FeatureFlagUser } from '../types/feature-flag.types';

/**
 * BE-47 — Guard that backs `@RequireFeatureFlag(...)`.
 *
 *   - Handlers without the metadata pass through unchanged.
 *   - Anonymous requests (no `req.user`) hitting a flag-gated handler
 *     get `404 NOT_FOUND`. Returning 401/403 would tell unauthenticated
 *     clients that a flag exists, which is more information than they
 *     need.
 *   - Disabled flags also produce `404 NOT_FOUND` — the route should
 *     appear to not exist for users outside the cohort.
 *
 * The guard depends on `FeatureFlagsService` for the actual lookup,
 * so consumers must `imports: [FeatureFlagsModule]` in the host
 * module that declares the guarded controller.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const flagName = this.reflector.getAllAndOverride<string | undefined>(FEATURE_FLAG_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!flagName) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: FeatureFlagUser }>();
    const user = req.user;
    if (!user || !user.id) {
      // Hide the existence of the flag from anonymous callers.
      throw new NotFoundException();
    }

    const enabled = await this.featureFlags.isEnabled(flagName, user);
    if (!enabled) {
      throw new NotFoundException();
    }
    return true;
  }
}
