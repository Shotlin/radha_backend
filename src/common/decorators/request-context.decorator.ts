import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * `@CurrentRequestId()` — controller param decorator that pulls the
 * current request id from the response header set by
 * `RequestIdMiddleware`. Convenient when a controller needs the id
 * without injecting `RequestContextService` directly.
 *
 * For richer access (userId, tenantId, etc.) consumers should inject
 * `RequestContextService` and call `getAll()`.
 */
export const CurrentRequestId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const header = req.headers['x-request-id'];
    if (typeof header === 'string') return header;
    if (Array.isArray(header) && header[0]) return header[0];
    return 'unknown';
  },
);
