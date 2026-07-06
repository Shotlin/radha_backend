import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { v4 as uuid, validate as isUuid } from 'uuid';

import { getSentryClient } from '../sentry.bootstrap';

/** Header name we accept and echo. Lower-cased per Express convention. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Hook the OTel bootstrap can populate so this middleware can tag the
 * active span without a hard dependency on `@opentelemetry/api`.
 *
 * Design note: we deliberately *don't* `require()` the OTel API from
 * the middleware. That would either (a) force every install to ship
 * the OTel runtime, defeating the optional-dependency goal, or (b)
 * require an `eslint-disable` for `no-require-imports` which the
 * server's `--max-warnings 0` policy rejects. Instead the bootstrap
 * publishes a tiny accessor and the middleware probes it.
 */
type GetActiveSpanFn = () => { setAttribute?: (key: string, value: string) => void } | undefined;

interface CorrelationIdMiddlewareGlobals {
  __radhaOtelGetActiveSpan?: GetActiveSpanFn;
}

const globalRegistry = globalThis as CorrelationIdMiddlewareGlobals;

/**
 * Called by `otel.bootstrap.ts` after `initOtel()` succeeds so the
 * correlation middleware can attach `correlation.id` to the active
 * span. Pass `undefined` to clear the hook (used in `shutdownOtel`).
 */
export function registerOtelActiveSpanAccessor(fn: GetActiveSpanFn | undefined): void {
  globalRegistry.__radhaOtelGetActiveSpan = fn;
}

/**
 * Cross-system correlation ID middleware (BE-48).
 *
 * Distinct from `RequestIdMiddleware`:
 *   - `requestId` is generated per request, scoped to *this* server.
 *   - `correlationId` flows *across* systems (Mobile App → API →
 *     workers → external webhooks) so a single user action can be
 *     stitched together across Sentry, OTel traces, and structured
 *     logs.
 *
 * Behaviour:
 *   1. If the inbound request already carries a valid UUID v4 in
 *      `X-Correlation-Id`, use it verbatim.
 *   2. Otherwise generate a fresh UUID v4.
 *   3. Stamp it back on the request header (so downstream NestJS
 *      handlers see it), the response header (so callers can stitch
 *      logs end-to-end), and the CLS store (so the logger / repos /
 *      audit-log service auto-include it).
 *   4. Surface it on the active Sentry scope (as a tag) and the OTel
 *      span attributes when those SDKs are loaded — both calls are
 *      best-effort and never break the request path.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const candidate =
      typeof incoming === 'string'
        ? incoming
        : Array.isArray(incoming) && typeof incoming[0] === 'string'
          ? incoming[0]
          : '';

    const correlationId = candidate.length > 0 && isUuid(candidate) ? candidate : uuid();

    // Stamp on inbound headers so anything that re-reads them sees
    // the canonical value (handlers that forward to downstream HTTP
    // calls can copy from req.headers).
    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);

    // CLS store — picked up by LoggerService, AuditLogService, and
    // anything else that goes through RequestContextService.
    try {
      this.cls.set('correlationId', correlationId);
    } catch {
      // CLS store may not be active in unusual middleware ordering;
      // never fail the request because of it.
    }

    this.tagSentry(correlationId);
    this.tagOtel(correlationId);

    next();
  }

  private tagSentry(correlationId: string): void {
    const sentry = getSentryClient();
    if (!sentry) return;
    try {
      sentry.setTag('correlationId', correlationId);
    } catch {
      /* swallow — non-fatal */
    }
  }

  private tagOtel(correlationId: string): void {
    const accessor = globalRegistry.__radhaOtelGetActiveSpan;
    if (!accessor) return;
    try {
      const span = accessor();
      span?.setAttribute?.('correlation.id', correlationId);
    } catch {
      /* swallow — non-fatal */
    }
  }
}
