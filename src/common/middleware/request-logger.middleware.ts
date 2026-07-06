import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { RequestContextService } from '@/common/context/request-context.service';
import { redactPII } from '@/common/utils/redact.utils';

/**
 * Logs one line on inbound request and one line on response finish,
 * including duration and status code. Body is redacted before logging
 * so PII never lands in stdout.
 *
 * `nestjs-pino`'s built-in pinoHttp also produces request logs at the
 * Pino level — this middleware sits at NestJS Logger level and uses
 * the typed RequestContextService to ensure the requestId we emit
 * matches the one in the response header.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Http');

  constructor(private readonly context: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = this.context.getRequestId();
    const { method, originalUrl } = req;
    const userAgent = req.headers['user-agent'];

    this.logger.log({
      msg: 'request.in',
      requestId,
      method,
      path: originalUrl,
      userAgent,
    });

    res.on('finish', () => {
      const durationMs = this.context.getDuration();
      const status = res.statusCode;
      const payload = {
        msg: 'request.out',
        requestId,
        method,
        path: originalUrl,
        status,
        durationMs,
      };
      if (status >= 500) {
        this.logger.error({ ...payload, body: redactPII(req.body as unknown) });
      } else if (status >= 400) {
        this.logger.warn(payload);
      } else if (durationMs > 2_000) {
        // Performance-watch: anything over 2s is worth a warn line for BE-32.
        this.logger.warn({ ...payload, msg: 'request.slow' });
      } else {
        this.logger.log(payload);
      }
    });

    next();
  }
}
