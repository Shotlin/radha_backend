import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';

import { RequestContextService } from '@/common/context/request-context.service';

/**
 * Standardises every successful response into the envelope:
 *
 *   {
 *     success: true,
 *     data: <handler return value>,
 *     meta: { requestId, timestamp, durationMs }
 *   }
 *
 * Endpoints that need to opt out (e.g. file streams) can decorate
 * their handler with `@SkipResponseInterceptor()`.
 */
export const SKIP_RESPONSE_ENVELOPE = 'skipResponseEnvelope';
export const SkipResponseInterceptor = (): MethodDecorator =>
  SetMetadata(SKIP_RESPONSE_ENVELOPE, true);

interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
    durationMs: number;
  };
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessEnvelope<T> | T> {
  constructor(
    private readonly context: RequestContextService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler<T>): Observable<SuccessEnvelope<T> | T> {
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_RESPONSE_ENVELOPE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    return next.handle().pipe(
      map((data) => {
        if (skip) return data;
        return {
          success: true as const,
          data,
          meta: {
            requestId: this.context.getRequestId(),
            timestamp: new Date().toISOString(),
            durationMs: this.context.getDuration(),
          },
        };
      }),
    );
  }
}
