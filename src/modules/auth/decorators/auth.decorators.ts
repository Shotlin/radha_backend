import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';

import type { UserRole } from '@/shared-types';

import type { AuthenticatedUser, Permission } from '../types/permission.types';

/**
 * Metadata keys + decorator helpers.
 *
 * Guards in `guards/` read these metadata via `Reflector` to decide
 * whether a handler is public, requires roles, requires permissions,
 * or requires tenant scope validation.
 */

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';
export const PERMISSIONS_KEY = 'auth:permissions';
export const REQUIRE_TENANT_KEY = 'auth:requireTenant';

/** Disable JwtAuthGuard for a handler (public endpoint). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict the handler to a list of roles. Empty list ⇒ allow any authenticated user. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Require all of the listed permissions. */
export const RequirePermissions = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions);

/** Validate tenant scope when present in `req.params.tenantId` / `req.headers['x-tenant-id']`. */
export const RequireTenant = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_TENANT_KEY, true);

/** Inject the current authenticated user (or one of its fields). */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    return field ? req.user?.[field] : req.user;
  },
);

/** Inject the current tenant id (string | null). */
export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
  return req.user?.tenantId ?? null;
});

/** Inject the requested store id from header / param. */
export const CurrentStore = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<{
    headers: Record<string, string | string[] | undefined>;
    params: Record<string, string>;
  }>();
  const header = req.headers['x-store-id'];
  if (typeof header === 'string') return header;
  return req.params?.storeId ?? null;
});
