import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { RequestContextService } from '@/common/context/request-context.service';
import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode, ERROR_CODE_TO_HTTP_STATUS } from '@/common/errors/error-codes';
import { redactPII } from '@/common/utils/redact.utils';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

/**
 * Catches every exception thrown by a controller, guard, pipe, or
 * interceptor and renders the standard error envelope:
 *
 *   {
 *     success: false,
 *     error: { code, message, details? },
 *     meta:  { requestId, timestamp, path }
 *   }
 *
 * BE-04: also forwards 5xx and unknown throwables to the
 * error-tracking service (Sentry in prod, no-op locally) with the
 * request context attached.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(
    private readonly context: RequestContextService,
    @Optional()
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracker?: IErrorTrackingService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpCtx = host.switchToHttp();
    const response = httpCtx.getResponse<Response>();
    const request = httpCtx.getRequest<Request>();
    const requestId = this.context.getRequestId();

    let status: number;
    let code: string;
    let message: string;
    let details: unknown;
    let shouldReportToTracker = false;
    let trackerError: Error | undefined;

    if (exception instanceof BusinessException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      // 5xx domain errors do go to the tracker; 4xx domain errors don't.
      if (status >= 500) {
        shouldReportToTracker = true;
        trackerError = exception;
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        code = this.statusToCode(status);
        message = body;
      } else {
        const obj = body as Record<string, unknown>;
        code = (obj.code as string) || this.statusToCode(status);
        message = (obj.message as string) || exception.message;
        details = obj.details;
      }
      if (status >= 500) {
        shouldReportToTracker = true;
        trackerError = exception;
      }
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCode.INTERNAL_SERVER_ERROR;
      message = 'An unexpected error occurred';
      shouldReportToTracker = true;
      trackerError = exception;
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCode.UNKNOWN_ERROR;
      message = 'An unknown error occurred';
      shouldReportToTracker = true;
      trackerError = new Error(`Non-Error throwable: ${String(exception)}`);
    }

    if (status >= 500) {
      this.logger.error({
        requestId,
        path: request.url,
        method: request.method,
        code,
        message: trackerError?.message ?? message,
        stack: trackerError?.stack,
        body: redactPII(request.body as unknown),
      });
    } else {
      this.logger.warn({
        requestId,
        path: request.url,
        method: request.method,
        status,
        code,
      });
    }

    if (shouldReportToTracker && trackerError && this.errorTracker) {
      this.errorTracker.captureException(trackerError, {
        requestId,
        userId: this.context.getUserId(),
        tenantId: this.context.getTenantId(),
        metadata: {
          path: request.url,
          method: request.method,
          code,
        },
      });
    }

    response.status(status).json({
      success: false,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        path: request.url,
      },
    });
  }

  private statusToCode(status: number): string {
    // Reverse-lookup the canonical ErrorCode for this HTTP status,
    // preferring the most specific generic per family.
    const fallback: Record<number, ErrorCode> = {
      400: ErrorCode.VALIDATION_ERROR,
      401: ErrorCode.AUTHENTICATION_REQUIRED,
      402: ErrorCode.PAYMENT_REQUIRED,
      403: ErrorCode.FORBIDDEN,
      404: ErrorCode.NOT_FOUND,
      408: ErrorCode.TIMEOUT,
      409: ErrorCode.CONFLICT,
      410: ErrorCode.RESOURCE_GONE,
      413: ErrorCode.REQUEST_TOO_LARGE,
      422: ErrorCode.BUSINESS_RULE_VIOLATION,
      429: ErrorCode.RATE_LIMIT_EXCEEDED,
      500: ErrorCode.INTERNAL_SERVER_ERROR,
      502: ErrorCode.EXTERNAL_SERVICE_ERROR,
      503: ErrorCode.SERVICE_UNAVAILABLE,
      504: ErrorCode.TIMEOUT,
    };
    const code = fallback[status];
    if (!code) return ErrorCode.UNKNOWN_ERROR;
    // Ensure the code we return actually maps back to this status —
    // catches drift between this lookup and the canonical map.
    return ERROR_CODE_TO_HTTP_STATUS[code] === status ? code : ErrorCode.UNKNOWN_ERROR;
  }
}
