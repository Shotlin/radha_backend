import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';
import { PermissionsService } from '@/modules/auth/services/permissions.service';

import { UserStoreAccessRepository } from '../repositories/user-store-access.repository';

export const REQUIRE_STORE_KEY = 'auth:requireStore';
export const RequireStore = (): MethodDecorator & ClassDecorator =>
  ((target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) Reflect.defineMetadata(REQUIRE_STORE_KEY, true, descriptor.value as object);
    else Reflect.defineMetadata(REQUIRE_STORE_KEY, true, target);
    return descriptor as TypedPropertyDescriptor<unknown>;
  }) as MethodDecorator & ClassDecorator;

/**
 * Enforces store-level access on routes annotated with `@RequireStore()`.
 *
 *   - Resolves the requested store from `:storeId` URL param or
 *     `X-Store-Id` header.
 *   - Owners and admins bypass the access check (they have implicit
 *     access to every store in the tenant).
 *   - Other roles need a row in `user_store_access`. The lookup is a
 *     single indexed query — fine for the request hot path.
 */
@Injectable()
export class StoreScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    private readonly access: UserStoreAccessRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const enabled = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_STORE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!enabled) return true;

    const req = ctx.switchToHttp().getRequest<{
      params: Record<string, string>;
      headers: Record<string, string | string[] | undefined>;
      user?: AuthenticatedUser;
    }>();
    const user = req.user;
    if (!user) {
      throw new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'Authentication required');
    }

    const storeId = this.resolveStore(req);
    if (!storeId) return true;

    if (this.permissions.canAccessStore(user, storeId)) return true;

    const access = await this.access.findActive(user.id, storeId);
    if (!access) {
      throw new BusinessException(ErrorCode.STORE_ACCESS_DENIED, 'Access to this store is denied', {
        metadata: { storeId },
      });
    }
    return true;
  }

  private resolveStore(req: {
    params: Record<string, string>;
    headers: Record<string, string | string[] | undefined>;
  }): string | null {
    if (req.params?.storeId) return req.params.storeId;
    const h = req.headers?.['x-store-id'];
    if (typeof h === 'string') return h;
    return null;
  }
}
