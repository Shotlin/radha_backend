import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { PERMISSIONS_KEY } from '../decorators/auth.decorators';
import { PermissionsService } from '../services/permissions.service';
import type { AuthenticatedUser, Permission } from '../types/permission.types';

/**
 * Enforces fine-grained `@RequirePermissions(...)` declarations.
 *
 * `INSUFFICIENT_PERMISSIONS` is rendered with the required and held
 * permissions in `details.metadata` so an admin debugging a 403 can
 * see exactly which permission was missing.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user) {
      throw new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'Authentication required');
    }

    if (!this.permissions.hasAllPermissions(user, required)) {
      throw new BusinessException(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Missing required permission',
        { metadata: { required, role: user.role } },
      );
    }
    return true;
  }
}
