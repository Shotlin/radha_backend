import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  REQUIRE_TENANT_KEY,
  ROLES_KEY,
} from '../decorators/auth.decorators';
import { PermissionsGuard } from '../guards/permissions.guard';
import { RolesGuard } from '../guards/roles.guard';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';
import { PermissionsService } from '../services/permissions.service';
import type { AuthenticatedUser, Permission } from '../types/permission.types';

const buildCtx = (
  metadata: Map<string, unknown>,
  request: Record<string, unknown>,
): ExecutionContext => {
  const reflectorTarget = Symbol('handler');
  return {
    getHandler: () => reflectorTarget as unknown as () => void,
    getClass: () => reflectorTarget as unknown as new () => unknown,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

const buildReflector = (metadata: Map<string, unknown>): Reflector => {
  const r = new Reflector();
  jest.spyOn(r, 'getAllAndOverride').mockImplementation((key) => metadata.get(key as string));
  return r;
};

const consumerUser: AuthenticatedUser = {
  id: 'u-1',
  tenantId: 't-1',
  role: 'consumer',
  permissions: [],
  storeIds: [],
  sessionId: 's-1',
  subscriptionTier: 'free_consumer',
};

const ownerUser: AuthenticatedUser = { ...consumerUser, role: 'owner' };
const adminUser: AuthenticatedUser = { ...consumerUser, role: 'admin', tenantId: null };

describe('RolesGuard', () => {
  it('allows when no roles required', () => {
    const ctx = buildCtx(new Map([[ROLES_KEY, []]]), { user: consumerUser });
    expect(new RolesGuard(buildReflector(new Map([[ROLES_KEY, []]]))).canActivate(ctx)).toBe(true);
  });

  it('throws AUTHENTICATION_REQUIRED when user is missing', () => {
    const md = new Map<string, unknown>([[ROLES_KEY, ['owner']]]);
    const ctx = buildCtx(md, {});
    expect(() => new RolesGuard(buildReflector(md)).canActivate(ctx)).toThrow(BusinessException);
  });

  it('throws ROLE_REQUIRED for the wrong role', () => {
    const md = new Map<string, unknown>([[ROLES_KEY, ['owner', 'manager']]]);
    const ctx = buildCtx(md, { user: consumerUser });
    try {
      new RolesGuard(buildReflector(md)).canActivate(ctx);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.ROLE_REQUIRED);
    }
  });

  it('passes when user holds an allowed role', () => {
    const md = new Map<string, unknown>([[ROLES_KEY, ['owner']]]);
    const ctx = buildCtx(md, { user: ownerUser });
    expect(new RolesGuard(buildReflector(md)).canActivate(ctx)).toBe(true);
  });
});

describe('PermissionsGuard', () => {
  const svc = new PermissionsService();

  it('allows when no permissions required', () => {
    const md = new Map<string, unknown>([[PERMISSIONS_KEY, []]]);
    const ctx = buildCtx(md, { user: consumerUser });
    expect(new PermissionsGuard(buildReflector(md), svc).canActivate(ctx)).toBe(true);
  });

  it('throws INSUFFICIENT_PERMISSIONS when role lacks the permission', () => {
    const md = new Map<string, unknown>([
      [PERMISSIONS_KEY, ['products:write'] satisfies Permission[]],
    ]);
    const ctx = buildCtx(md, { user: consumerUser });
    try {
      new PermissionsGuard(buildReflector(md), svc).canActivate(ctx);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.INSUFFICIENT_PERMISSIONS);
    }
  });

  it('passes when user holds every required permission', () => {
    const md = new Map<string, unknown>([
      [PERMISSIONS_KEY, ['products:write', 'inventory:write'] satisfies Permission[]],
    ]);
    const ctx = buildCtx(md, { user: { ...ownerUser, permissions: [] } });
    expect(new PermissionsGuard(buildReflector(md), svc).canActivate(ctx)).toBe(true);
  });
});

describe('TenantScopeGuard', () => {
  const svc = new PermissionsService();

  it('skips when @RequireTenant() is not set', () => {
    const md = new Map<string, unknown>();
    const ctx = buildCtx(md, { user: consumerUser, params: { tenantId: 't-other' } });
    expect(new TenantScopeGuard(buildReflector(md), svc).canActivate(ctx)).toBe(true);
  });

  it('throws TENANT_ACCESS_DENIED when tenant in URL differs', () => {
    const md = new Map<string, unknown>([[REQUIRE_TENANT_KEY, true]]);
    const req = {
      user: consumerUser,
      params: { tenantId: 't-other' },
      headers: {},
      query: {},
    };
    const ctx = buildCtx(md, req);
    try {
      new TenantScopeGuard(buildReflector(md), svc).canActivate(ctx);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.TENANT_ACCESS_DENIED);
    }
  });

  it('admin bypasses the tenant check', () => {
    const md = new Map<string, unknown>([[REQUIRE_TENANT_KEY, true]]);
    const req = {
      user: adminUser,
      params: { tenantId: 'any' },
      headers: {},
      query: {},
    };
    const ctx = buildCtx(md, req);
    expect(new TenantScopeGuard(buildReflector(md), svc).canActivate(ctx)).toBe(true);
  });

  it('passes when no tenant scope is requested in the route', () => {
    const md = new Map<string, unknown>([[REQUIRE_TENANT_KEY, true]]);
    const req = { user: consumerUser, params: {}, headers: {}, query: {} };
    const ctx = buildCtx(md, req);
    expect(new TenantScopeGuard(buildReflector(md), svc).canActivate(ctx)).toBe(true);
  });
});

describe('@Public() metadata', () => {
  // We don't unit-test JwtAuthGuard's full lookup path here (it requires DB);
  // just verify the metadata key constant is the agreed string.
  it('IS_PUBLIC_KEY constant is stable', () => {
    expect(IS_PUBLIC_KEY).toBe('auth:isPublic');
  });
});
