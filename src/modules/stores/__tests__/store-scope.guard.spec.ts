import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { PermissionsService } from '@/modules/auth/services/permissions.service';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import { StoreScopeGuard, REQUIRE_STORE_KEY } from '../guards/store-scope.guard';
import { UserStoreAccessRepository } from '../repositories/user-store-access.repository';

const buildCtx = (
  metadata: Map<string, unknown>,
  request: Record<string, unknown>,
): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const buildReflector = (md: Map<string, unknown>): Reflector => {
  const r = new Reflector();
  jest.spyOn(r, 'getAllAndOverride').mockImplementation((key) => md.get(key as string));
  return r;
};

const staffUser: AuthenticatedUser = {
  id: 'u-staff',
  tenantId: 't-1',
  role: 'staff',
  permissions: [],
  storeIds: [],
  sessionId: 's-1',
  subscriptionTier: 'starter',
};

const ownerUser: AuthenticatedUser = { ...staffUser, role: 'owner' };
const adminUser: AuthenticatedUser = { ...staffUser, role: 'admin' };

describe('StoreScopeGuard', () => {
  const buildAccess = (findActive?: jest.Mock): UserStoreAccessRepository =>
    ({
      findActive: findActive ?? jest.fn().mockResolvedValue(null),
    }) as unknown as UserStoreAccessRepository;

  const permissions = new PermissionsService();

  it('skips when @RequireStore() is not set', async () => {
    const md = new Map<string, unknown>();
    const ctx = buildCtx(md, {
      user: staffUser,
      params: { storeId: 's-x' },
      headers: {},
    });
    const guard = new StoreScopeGuard(buildReflector(md), permissions, buildAccess());
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('owner bypasses store check', async () => {
    const md = new Map<string, unknown>([[REQUIRE_STORE_KEY, true]]);
    const ctx = buildCtx(md, {
      user: ownerUser,
      params: { storeId: 's-x' },
      headers: {},
    });
    const guard = new StoreScopeGuard(buildReflector(md), permissions, buildAccess());
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('admin bypasses store check', async () => {
    const md = new Map<string, unknown>([[REQUIRE_STORE_KEY, true]]);
    const ctx = buildCtx(md, {
      user: adminUser,
      params: { storeId: 's-x' },
      headers: {},
    });
    const guard = new StoreScopeGuard(buildReflector(md), permissions, buildAccess());
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('staff with active access passes', async () => {
    const md = new Map<string, unknown>([[REQUIRE_STORE_KEY, true]]);
    const ctx = buildCtx(md, {
      user: staffUser,
      params: { storeId: 's-x' },
      headers: {},
    });
    const access = buildAccess(jest.fn().mockResolvedValue({ id: 'a-1', isActive: true }));
    const guard = new StoreScopeGuard(buildReflector(md), permissions, access);
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('staff without access throws STORE_ACCESS_DENIED', async () => {
    const md = new Map<string, unknown>([[REQUIRE_STORE_KEY, true]]);
    const ctx = buildCtx(md, {
      user: staffUser,
      params: { storeId: 's-x' },
      headers: {},
    });
    const guard = new StoreScopeGuard(buildReflector(md), permissions, buildAccess());
    try {
      await guard.canActivate(ctx);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.STORE_ACCESS_DENIED);
    }
  });
});
