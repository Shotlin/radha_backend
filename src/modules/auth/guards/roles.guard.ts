import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { UserRole } from '@/shared-types';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { ROLES_KEY } from '../decorators/auth.decorators';
import type { AuthenticatedUser } from '../types/permission.types';

/**
 * Asserts the requesting user holds one of the roles listed by
 * `@Roles(...)`. Empty list (or no decorator) ⇒ allow any
 * authenticated user. Cooperates with `JwtAuthGuard`: assumes
 * `req.user` is already populated, throws
 * `AUTHENTICATION_REQUIRED` if not.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user) {
      throw new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'Authentication required');
    }
    if (!required.includes(user.role)) {
      throw new BusinessException(
        ErrorCode.ROLE_REQUIRED,
        `One of these roles is required: ${required.join(', ')}`,
        { metadata: { required, actual: user.role } },
      );
    }
    return true;
  }
}
