import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { REQUIRE_ENTITLEMENT_KEY } from '../decorators/require-entitlement.decorator';
import { EntitlementGuard } from '../guards/entitlement.guard';
import { EntitlementService } from '../services/entitlement.service';
import type { EntitlementCheck } from '../types/subscription.types';

const buildCtx = (
  _metadata: string | undefined,
  user?: { tenantId?: string | null },
): ExecutionContext =>
  ({
    getHandler: () => 'handler',
    getClass: () => 'klass',
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  }) as unknown as ExecutionContext;

const buildReflector = (metadata: string | undefined): Reflector =>
  ({
    getAllAndOverride: jest.fn(() => metadata),
  }) as unknown as Reflector;

const buildEntitlementService = (check: EntitlementCheck): EntitlementService =>
  ({
    checkEntitlement: jest.fn(async () => check),
  }) as unknown as EntitlementService;

describe('EntitlementGuard', () => {
  it('passes through when no @RequireEntitlement metadata', async () => {
    const reflector = buildReflector(undefined);
    const svc = buildEntitlementService({
      allowed: true,
      feature: 'monthly_scans',
      currentUsage: 0,
      limit: 0,
      remaining: 0,
    });
    const guard = new EntitlementGuard(reflector, svc);
    const ok = await guard.canActivate(buildCtx(undefined));
    expect(ok).toBe(true);
  });

  it('throws AUTHENTICATION_REQUIRED when no tenant on the request', async () => {
    const reflector = buildReflector('monthly_scans');
    const svc = buildEntitlementService({
      allowed: true,
      feature: 'monthly_scans',
      currentUsage: 0,
      limit: 0,
      remaining: 0,
    });
    const guard = new EntitlementGuard(reflector, svc);
    await expect(guard.canActivate(buildCtx('monthly_scans', {}))).rejects.toMatchObject({
      code: ErrorCode.AUTHENTICATION_REQUIRED,
    });
  });

  it('returns true when entitlement check passes', async () => {
    const reflector = buildReflector('monthly_scans');
    const svc = buildEntitlementService({
      allowed: true,
      feature: 'monthly_scans',
      currentUsage: 1_000,
      limit: 5_000,
      remaining: 4_000,
    });
    const guard = new EntitlementGuard(reflector, svc);
    const ok = await guard.canActivate(buildCtx('monthly_scans', { tenantId: 'tenant-1' }));
    expect(ok).toBe(true);
  });

  it('throws PLAN_LIMIT_EXCEEDED when usage hits the cap', async () => {
    const reflector = buildReflector('monthly_scans');
    const svc = buildEntitlementService({
      allowed: false,
      feature: 'monthly_scans',
      currentUsage: 5_000,
      limit: 5_000,
      remaining: 0,
      reason: 'Monthly limit of 5000 reached',
      upgradeRequired: true,
      recommendedPlan: 'growth',
    });
    const guard = new EntitlementGuard(reflector, svc);
    await expect(
      guard.canActivate(buildCtx('monthly_scans', { tenantId: 'tenant-1' })),
    ).rejects.toMatchObject({
      code: ErrorCode.PLAN_LIMIT_EXCEEDED,
    });
  });

  it('throws SUBSCRIPTION_REQUIRED when feature not in plan', async () => {
    const reflector = buildReflector('api_access');
    const svc = buildEntitlementService({
      allowed: false,
      feature: 'api_access',
      currentUsage: 0,
      limit: 0,
      remaining: 0,
      reason: 'Feature not in plan',
      upgradeRequired: true,
      recommendedPlan: 'pro',
    });
    const guard = new EntitlementGuard(reflector, svc);
    await expect(
      guard.canActivate(buildCtx('api_access', { tenantId: 'tenant-1' })),
    ).rejects.toMatchObject({
      code: ErrorCode.SUBSCRIPTION_REQUIRED,
    });
  });

  it('exposes feature + recommendedPlan in the exception details', async () => {
    const reflector = buildReflector('monthly_scans');
    const svc = buildEntitlementService({
      allowed: false,
      feature: 'monthly_scans',
      currentUsage: 5_000,
      limit: 5_000,
      remaining: 0,
      reason: 'Monthly limit reached',
      upgradeRequired: true,
      recommendedPlan: 'growth',
    });
    const guard = new EntitlementGuard(reflector, svc);
    let captured: BusinessException | null = null;
    try {
      await guard.canActivate(buildCtx('monthly_scans', { tenantId: 'tenant-1' }));
    } catch (err) {
      captured = err as BusinessException;
    }
    expect(captured).toBeInstanceOf(BusinessException);
    expect(captured?.details?.metadata).toMatchObject({
      feature: 'monthly_scans',
      recommendedPlan: 'growth',
    });
  });
});

describe('REQUIRE_ENTITLEMENT_KEY', () => {
  it('exposes a stable metadata key', () => {
    expect(REQUIRE_ENTITLEMENT_KEY).toBe('subscriptions:requireEntitlement');
  });
});
