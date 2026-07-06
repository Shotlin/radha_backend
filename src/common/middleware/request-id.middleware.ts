import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { v4 as uuid } from 'uuid';

import { DEFAULT_REQUEST_ID_HEADER } from '@/common/constants';

/**
 * Ensures every inbound request has an `X-Request-Id` and that the
 * same id is echoed on the response.
 *
 * Sits *after* the ClsMiddleware so that the request id stored in the
 * CLS store and the one returned to the caller are guaranteed to match.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const fromHeader = req.headers[DEFAULT_REQUEST_ID_HEADER];

    // Resolve the id from (in order) the inbound header, the CLS store
    // (populated by ClsModule's auto-mounted middleware via `idGenerator`),
    // or a freshly-minted UUID. We never call `cls.get` outside an active
    // CLS context — `nestjs-cls` throws when accessed from a request that
    // hasn't been wrapped, which would surface as a generic 500 to clients.
    const headerId =
      typeof fromHeader === 'string' && fromHeader.length > 0
        ? fromHeader
        : Array.isArray(fromHeader) && fromHeader[0]
          ? fromHeader[0]
          : undefined;

    const clsActive = this.cls.isActive();
    const requestId = headerId ?? (clsActive ? this.cls.get<string>('requestId') : undefined) ?? uuid();

    if (clsActive) {
      this.cls.set('requestId', requestId);
    }
    req.headers[DEFAULT_REQUEST_ID_HEADER] = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
