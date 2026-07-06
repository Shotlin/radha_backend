import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { QUOTA_METADATA_KEY } from '../decorators/quota.decorator';
import type { QuotaExceededResponse, QuotaKind } from '../dto/rate-limit-result.dto';
import { RateLimitService } from '../services/rate-limit.service';

interface RequestWithUser {
  user?: { id?: string | null } | null;
}

/**
 * BE-46 — Per-user quota guard.
 *
 * Reads the `@Quota(...)` metadata; if absent the guard is a
 * pass-through (so adding the guard globally is safe). Otherwise:
 *   1. Resolve `req.user.id` set by `JwtAuthGuard` (BE-08).
 *   2. Call `RateLimitService.checkAndIncrement(userId, kind)`.
 *   3. If allowed, return true.
 *   4. If denied, throw `HttpException(429)` with the structured
 *      body specified in BE-46 (`{ allowed, quota, limit, used,
 *      resetAt }`) — the mobile client switches on `code` to show
 *      the correct upgrade prompt.
 *
 * The guard intentionally runs *before* any DB write — Nest
 * resolves guards in the order declared on the controller, so
 * make sure `@UseGuards(JwtAuthGuard, ..., QuotaGuard)` keeps
 * `QuotaGuard` last in the auth chain but ahead of any custom
 * pipe / interceptor that mutates state.
 */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<QuotaKind | undefined>(QUOTA_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!kind) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authenticated user required for quota-gated endpoint');
    }

    const result = await this.rateLimit.checkAndIncrement(userId, kind);
    if (result.allowed) return true;

    const body: QuotaExceededResponse = {
      allowed: false,
      quota: result.quota ?? kind,
      limit: result.limit ?? 0,
      used: result.used ?? 0,
      resetAt: result.resetAt ?? new Date().toISOString(),
      window: result.window ?? 'daily',
      code: 'QUOTA_EXCEEDED',
      message: `Quota exceeded for ${result.quota ?? kind}. Resets at ${result.resetAt ?? 'next reset'}.`,
    };

    throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}
