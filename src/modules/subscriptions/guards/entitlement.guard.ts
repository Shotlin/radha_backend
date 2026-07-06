import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { REQUIRE_ENTITLEMENT_KEY } from '../decorators/require-entitlement.decorator';
import { EntitlementService } from '../services/entitlement.service';
import type { Feature } from '../types/subscription.types';

/**
 * BE-28 — Route-level entitlement guard.
 *
 * Reads the `@RequireEntitlement(...)` metadata. If absent the guard
 * is a pass-through. When present:
 *   1. Resolve the tenant from `req.user.tenantId` (BE-08).
 *   2. Call `EntitlementService.checkEntitlement(tenantId, feature)`.
 *   3. If allowed, return true.
 *   4. If not allowed, throw a BusinessException with either
 *      `PLAN_LIMIT_EXCEEDED` (cap reached) or `SUBSCRIPTION_REQUIRED`
 *      (feature not in plan / no subscription). HTTP status is 402
 *      via the canonical mapping.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlement: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<Feature | undefined>(REQUIRE_ENTITLEMENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { tenantId?: string | null };
    }>();
    const tenantId = request.user?.tenantId;
    if (!tenantId) {
      throw new BusinessException(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'Authenticated tenant context is required for this endpoint',
      );
    }

    const check = await this.entitlement.checkEntitlement(tenantId, feature);
    if (check.allowed) return true;

    // Discriminate between "cap reached" and "feature not in plan".
    // Both yield 402 but the code differentiates billing UI flows.
    const code =
      typeof check.limit === 'number' && check.currentUsage >= check.limit && check.limit > 0
        ? ErrorCode.PLAN_LIMIT_EXCEEDED
        : ErrorCode.SUBSCRIPTION_REQUIRED;

    throw new BusinessException(code, check.reason ?? 'Feature not available in current plan', {
      metadata: {
        feature,
        currentUsage: check.currentUsage,
        limit: check.limit,
        remaining: check.remaining,
        recommendedPlan: check.recommendedPlan,
      },
    });
  }
}
