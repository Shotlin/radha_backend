import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Public } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import {
  MyBadgeResponseDto,
  VerifyBadgeParamSchema,
  VerifyBadgeResponseDto,
} from '../dto/badge.dto';
import { VerifiedBadgeService } from '../services/verified-badge.service';

/**
 * BE-52 — RADHA Verified Badge HTTP surface.
 *
 *   GET /api/v1/badges/me        — authenticated, tenant-scoped
 *   GET /api/v1/verify/:tenantSlug — public, cache-friendly
 *
 * The `/badges/me` endpoint sits behind `JwtAuthGuard` (the same
 * guard every other authenticated module uses) and reads the tenant
 * id from the authenticated user. The verify endpoint is marked
 * `@Public()` so it bypasses the guard, and adds a 1-hour
 * `Cache-Control` header so badge widgets embedded on third-party
 * sites can be cached aggressively.
 *
 * The two routes deliberately live on the same controller (rather
 * than splitting public-vs-private) because they both render the
 * same domain object and share the same DI graph; the per-handler
 * `@Public()` flag is the well-trodden Nest pattern for this.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class VerifiedBadgeController {
  constructor(private readonly svc: VerifiedBadgeService) {}

  @Get('badges/me')
  @Version('1')
  async getMyBadge(@CurrentUser() user: AuthenticatedUser): Promise<MyBadgeResponseDto> {
    if (!user.tenantId) {
      throw new ForbiddenException('Verified badge requires a tenant scope');
    }
    return this.svc.getMyBadge(user.tenantId);
  }

  @Get('verify/:tenantSlug')
  @Version('1')
  @Public()
  // Public verify endpoint — cache 1 hour at any intermediary +
  // browser. The badge state itself only changes on the daily cron,
  // so even a stale-by-1-hour read is well within tolerance.
  @Header('Cache-Control', 'public, max-age=3600, s-maxage=3600')
  async verifyBySlug(
    @Param('tenantSlug', new ZodValidationPipe(VerifyBadgeParamSchema.shape.tenantSlug))
    tenantSlug: string,
  ): Promise<VerifyBadgeResponseDto> {
    return this.svc.verifyBySlug(tenantSlug);
  }
}
