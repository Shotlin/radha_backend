import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { v4 as uuid } from 'uuid';

import { DEFAULT_REQUEST_ID_HEADER } from '@/common/constants';

import { RequestContextService } from './request-context.service';

/**
 * Initialises a per-request CLS store and seeds the well-known fields
 * (requestId, startTime, userAgent, ipAddress) before any other
 * middleware or controller runs.
 *
 * The middleware is registered globally on every HTTP route via
 * `mount: true` + `generateId: true`, so consumers can safely call
 * `RequestContextService.getRequestId()` from anywhere in the request
 * lifecycle.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: { headers?: Record<string, string | string[] | undefined> }) => {
          const incoming = req.headers?.[DEFAULT_REQUEST_ID_HEADER];
          if (typeof incoming === 'string' && incoming.length > 0) return incoming;
          if (Array.isArray(incoming) && incoming[0]) return incoming[0];
          return uuid();
        },
        setup: (
          cls,
          req: {
            headers?: Record<string, string | string[] | undefined>;
            ip?: string;
            socket?: { remoteAddress?: string };
          },
        ) => {
          cls.set('startTime', Date.now());
          cls.set('userAgent', String(req.headers?.['user-agent'] ?? ''));
          cls.set('ipAddress', req.ip ?? req.socket?.remoteAddress ?? '');
          // requestId is populated by ClsModule from the idGenerator above
          // and additionally surfaced via RequestIdMiddleware on the response.
        },
      },
    }),
  ],
  providers: [RequestContextService],
  exports: [RequestContextService, ClsModule],
})
export class RequestContextModule {}
