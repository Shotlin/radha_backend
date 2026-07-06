import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import type { ImpersonatedRequest } from '../types/impersonation.types';

/**
 * BE-53 — Block destructive actions during an impersonation session.
 *
 * The guard runs AFTER `JwtAuthGuard` and the
 * `ImpersonationActionLoggerMiddleware` has resolved
 * `req.impersonationSession`. For requests that aren't impersonating
 * we no-op. For requests that are, we 403 if the path/method match
 * the destructive policy:
 *
 *   - Any `DELETE` request is destructive.
 *   - Any path that contains `/subscriptions/cancel` or
 *     `/account/delete` is destructive — staff cannot cancel a
 *     tenant's subscription or delete their account "as them".
 *
 * Wire it on every controller that handles tenant-side mutations.
 * `app.module.ts` (a different phase) registers it globally via
 * `APP_GUARD`.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<ImpersonatedRequest>();
    const session = req.impersonationSession;
    if (!session) return true;

    if (this.isDestructive(req)) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        'Destructive actions are blocked during impersonation',
        {
          metadata: {
            method: req.method,
            path: extractPath(req),
            impersonationSessionId: session.id,
          },
        },
      );
    }
    return true;
  }

  /**
   * Public for unit testing — encapsulates the destructive-action
   * matrix. Update in lockstep with the BE-53 spec.
   */
  isDestructive(req: Pick<ImpersonatedRequest, 'method' | 'path' | 'url' | 'originalUrl'>): boolean {
    const method = (req.method ?? '').toUpperCase();
    if (method === 'DELETE') return true;
    const path = extractPath(req);
    if (path.includes('/subscriptions/cancel')) return true;
    if (path.includes('/account/delete')) return true;
    return false;
  }
}

function extractPath(
  req: Pick<ImpersonatedRequest, 'path' | 'url' | 'originalUrl'>,
): string {
  // `req.path` is set by Express but missing on some test stubs;
  // fall back to `originalUrl` then `url`. Strip query string for
  // stable substring matching.
  const raw = (req.path || req.originalUrl || req.url || '') as string;
  const queryIdx = raw.indexOf('?');
  return queryIdx === -1 ? raw : raw.slice(0, queryIdx);
}
