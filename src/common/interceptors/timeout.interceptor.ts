import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, TimeoutError, catchError, throwError, timeout } from 'rxjs';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Bounds every request to a maximum execution time. Long-running work
 * (report generation, EAN imports, AI fallbacks) is still allowed by
 * routing through BullMQ jobs in BE-24+ — it does NOT happen inline
 * on a request.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly ms: number = DEFAULT_TIMEOUT_MS) {}

  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.ms),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException('Request timed out'));
        }
        return throwError(() => err);
      }),
    );
  }
}
