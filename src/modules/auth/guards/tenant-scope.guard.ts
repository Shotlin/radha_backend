import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { REQUIRE_TENANT_KEY } from '../decorators/auth.decorators';
import { PermissionsService } from '../services/permissions.service';
import type { AuthenticatedUser } from '../types/permission.types';

/**
 * When `@RequireTenant()` is set, this guard checks that the tenant
 * id supplied in the URL (`:tenantId` param), header
 * (`X-Tenant-Id`), or query (`?tenantId=`) matches the user's
 * active tenant.
 *
 * Admins bypass the check (they need cross-tenant visibility for
 * support cases — BE-31 + BE-53 audit those bypasses).
 *
 * BE-09 v2 ADDENDUM (Req 41) layers a database-level RLS check on top
 * so a missing decorator on a new endpoint can never leak data even if
 * a developer forgets to wire this guard.
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const enabled = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_TENANT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!enabled) return true;

    const req = ctx.switchToHttp().getRequest<{
      params: Record<string, string>;
      query: Record<string, string | string[] | undefined>;
      headers: Record<string, string | string[] | undefined>;
      user?: AuthenticatedUser;
    }>();

    const user = req.user;
    if (!user) {
      throw new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'Authentication required');
    }

    const tenantId = this.resolveTenant(req);
    if (!tenantId) return true;

    if (!this.permissions.canAccessTenant(user, tenantId)) {
      throw new BusinessException(
        ErrorCode.TENANT_ACCESS_DENIED,
        'Access to this tenant is denied',
        { metadata: { requested: tenantId, active: user.tenantId } },
      );
    }
    return true;
  }

  private resolveTenant(req: {
    params: Record<string, string>;
    query: Record<string, string | string[] | undefined>;
    headers: Record<string, string | string[] | undefined>;
  }): string | null {
    if (req.params?.tenantId) return req.params.tenantId;
    const header = req.headers?.['x-tenant-id'];
    if (typeof header === 'string') return header;
    const q = req.query?.tenantId;
    if (typeof q === 'string') return q;
    return null;
  }
}
