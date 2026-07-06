import { Controller, Get, UseGuards, Version } from '@nestjs/common';

import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import { FeatureFlagsMeResponse } from './dto/feature-flag.dto';
import { FeatureFlagsService } from './services/feature-flags.service';

/**
 * BE-47 — Public-by-auth endpoint Mobile_App polls every 5 minutes.
 *
 *   GET /api/v1/feature-flags/me
 *
 * Returns `Record<flagName, variantString>` for the authenticated
 * user. The variant is whatever the active provider returned —
 * `'on'` / `'off'` for boolean and rollout flags, or the variant
 * label for multivariate.
 *
 * Security note: we do not expose the flag table to unauthenticated
 * clients. Anonymous callers get a 401 from `JwtAuthGuard` before
 * they can see the list.
 */
@Controller('feature-flags')
@UseGuards(JwtAuthGuard)
export class FeatureFlagsController {
  constructor(private readonly featureFlags: FeatureFlagsService) {}

  @Get('me')
  @Version('1')
  async getMyFlags(@CurrentUser() user: AuthenticatedUser): Promise<FeatureFlagsMeResponse> {
    return this.featureFlags.getAll({ id: user.id, tenantId: user.tenantId });
  }
}
