import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RequestContextService } from '@/common/context/request-context.service';
import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { IS_PUBLIC_KEY } from '../decorators/auth.decorators';
import { UsersRepository } from '../repositories/users.repository';
import { AuthJwtService } from '../services/jwt.service';
import { PermissionsService } from '../services/permissions.service';
import type { AuthenticatedUser, Permission } from '../types/permission.types';

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Verifies the `Authorization: Bearer …` header against
 * `AuthJwtService.verifyAccessToken`, hydrates `AuthenticatedUser` from
 * `users` (via the `UsersRepository`), and stamps the request context
 * with userId / tenantId / role.
 *
 *   - Handlers decorated with `@Public()` skip this guard.
 *   - Stale or missing tokens surface as `BusinessException(TOKEN_*)`.
 *   - The BE-04 standard error envelope renders consistently because
 *     we never throw raw `UnauthorizedException`s with leaky messages.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: AuthJwtService,
    private readonly users: UsersRepository,
    private readonly permissions: PermissionsService,
    private readonly context: RequestContextService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthenticatedUser;
    }>();

    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || typeof value !== 'string') {
      throw new BusinessException(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'Authorization header missing',
      );
    }
    const match = BEARER_RE.exec(value);
    if (!match) {
      throw new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'Bearer token expected');
    }
    const token = match[1].trim();

    const payload = await this.jwt.verifyAccessToken(token);

    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new BusinessException(ErrorCode.TOKEN_REVOKED, 'User no longer exists');
    }
    if (!user.isActive) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account deactivated');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account temporarily locked');
    }

    const rolePerms = this.permissions.getRolePermissions(user.role);
    const authenticated: AuthenticatedUser = {
      id: user.id,
      tenantId: user.tenantId ?? null,
      role: user.role,
      permissions: Array.from(rolePerms) as Permission[],
      storeIds: [],
      sessionId: payload.sessionId,
      subscriptionTier: user.subscriptionTier,
      onboardingSegment: user.onboardingSegment ?? undefined,
    };

    req.user = authenticated;
    this.context.set('userId', authenticated.id);
    this.context.set('tenantId', authenticated.tenantId ?? undefined);
    this.context.set('role', authenticated.role);

    return true;
  }
}
