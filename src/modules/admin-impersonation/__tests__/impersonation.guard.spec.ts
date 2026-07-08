import { ExecutionContext } from '@nestjs/common';

import { ErrorCode } from '@/common/errors/error-codes';
import type { ImpersonationSessionRow } from '@/db/schema/impersonation';

import { ImpersonationGuard } from '../guards/impersonation.guard';
import type { ImpersonatedRequest } from '../types/impersonation.types';

/**
 * BE-53 — `ImpersonationGuard` unit tests.
 *
 * Covers:
 *   - non-impersonated request ⇒ allow,
 *   - impersonated GET ⇒ allow,
 *   - impersonated DELETE ⇒ FORBIDDEN,
 *   - impersonated POST to `/subscriptions/cancel` ⇒ FORBIDDEN,
 *   - impersonated POST to `/account/delete` ⇒ FORBIDDEN,
 *   - destructive matrix is path-aware (substring match on path),
 *   - `isDestructive` helper exposes the rule for unit testing.
 */

const SESSION_ROW: ImpersonationSessionRow = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  staffUserId: 'staff',
  impersonatedUserId: 'target',
  reason: 'Diagnosing billing problem.',
  startedAt: new Date(),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  endedAt: null,
  endedReason: null,
};

function ctxFor(req: Partial<ImpersonatedRequest>): ExecutionContext {
  const httpReq = {
    method: 'GET',
    path: '/api/v1/products',
    originalUrl: '/api/v1/products',
    url: '/api/v1/products',
    ...req,
  };
  return {
    switchToHttp: () => ({ getRequest: () => httpReq }),
  } as unknown as ExecutionContext;
}

describe('ImpersonationGuard', () => {
  const guard = new ImpersonationGuard();

  it('allows requests that do not carry an impersonation session', () => {
    const ctx = ctxFor({ method: 'DELETE', path: '/api/v1/products/1' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows safe (GET) requests during an impersonation session', () => {
    const ctx = ctxFor({
      method: 'GET',
      path: '/api/v1/products',
      impersonationSession: SESSION_ROW,
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('blocks DELETE requests during an impersonation session', () => {
    const ctx = ctxFor({
      method: 'DELETE',
      path: '/api/v1/products/1',
      impersonationSession: SESSION_ROW,
    });
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({ code: ErrorCode.FORBIDDEN }),
    );
  });

  it('blocks POST /subscriptions/cancel during an impersonation session', () => {
    const ctx = ctxFor({
      method: 'POST',
      path: '/api/v1/subscriptions/cancel',
      impersonationSession: SESSION_ROW,
    });
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({ code: ErrorCode.FORBIDDEN }),
    );
  });

  it('blocks POST /account/delete during an impersonation session', () => {
    const ctx = ctxFor({
      method: 'POST',
      path: '/api/v1/account/delete',
      impersonationSession: SESSION_ROW,
    });
    expect(() => guard.canActivate(ctx)).toThrow(
      expect.objectContaining({ code: ErrorCode.FORBIDDEN }),
    );
  });

  it('strips query strings before matching destructive paths', () => {
    expect(
      guard.isDestructive({
        method: 'POST',
        path: '/api/v1/subscriptions/cancel',
        url: '/api/v1/subscriptions/cancel?confirm=1',
        originalUrl: '/api/v1/subscriptions/cancel?confirm=1',
      } as ImpersonatedRequest),
    ).toBe(true);
  });

  it('isDestructive exposes the destructive rule for direct unit testing', () => {
    expect(
      guard.isDestructive({
        method: 'GET',
        path: '/api/v1/products',
        url: '',
        originalUrl: '',
      } as ImpersonatedRequest),
    ).toBe(false);
    expect(
      guard.isDestructive({
        method: 'DELETE',
        path: '/api/v1/anything',
        url: '',
        originalUrl: '',
      } as ImpersonatedRequest),
    ).toBe(true);
  });
});
