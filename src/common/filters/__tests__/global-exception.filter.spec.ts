import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

import { RequestContextService } from '@/common/context/request-context.service';
import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { IErrorTrackingService } from '@/observability/error-tracking.types';

import { GlobalExceptionFilter } from '../global-exception.filter';

const buildHost = (): {
  host: ArgumentsHost;
  res: {
    status: jest.Mock;
    json: jest.Mock;
    statusCode?: number;
    jsonBody?: unknown;
  };
} => {
  const res: {
    status: jest.Mock;
    json: jest.Mock;
    statusCode?: number;
    jsonBody?: unknown;
  } = {
    status: jest.fn().mockImplementation(function (code: number) {
      (res as { statusCode?: number }).statusCode = code;
      return res;
    }),
    json: jest.fn().mockImplementation((body: unknown) => {
      (res as { jsonBody?: unknown }).jsonBody = body;
      return res;
    }),
  };
  const req = { url: '/api/v1/x', method: 'POST', body: { password: 'p', name: 'n' } };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, res };
};

describe('GlobalExceptionFilter', () => {
  const ctx: jest.Mocked<RequestContextService> = {
    getRequestId: jest.fn(() => 'req-test'),
    getUserId: jest.fn(() => 'u-1'),
    getTenantId: jest.fn(() => 't-1'),
  } as unknown as jest.Mocked<RequestContextService>;

  const tracker: jest.Mocked<IErrorTrackingService> = {
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    setUser: jest.fn(),
    clearUser: jest.fn(),
    addBreadcrumb: jest.fn(),
    setTag: jest.fn(),
    setContext: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('formats HttpException with code and standard envelope', () => {
    const filter = new GlobalExceptionFilter(ctx, tracker);
    const { host, res } = buildHost();
    filter.catch(new NotFoundException('missing'), host);
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    const body = res.jsonBody as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect((body.error as Record<string, unknown>).code).toBe(ErrorCode.NOT_FOUND);
    expect((body.meta as Record<string, unknown>).requestId).toBe('req-test');
    // 404 is not reported to tracker
    expect(tracker.captureException).not.toHaveBeenCalled();
  });

  it('honours custom code in HttpException response object', () => {
    const filter = new GlobalExceptionFilter(ctx, tracker);
    const { host, res } = buildHost();
    filter.catch(
      new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'bad',
        details: [{ field: 'x', message: 'y' }],
      }),
      host,
    );
    expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = res.jsonBody as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe('VALIDATION_ERROR');
    expect((body.error as Record<string, unknown>).details).toBeDefined();
  });

  it('reports unknown errors to the tracker and hides internals from the client', () => {
    const filter = new GlobalExceptionFilter(ctx, tracker);
    const { host, res } = buildHost();
    const err = new Error('something blew up — secret=hunter2');
    filter.catch(err, host);
    expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = res.jsonBody as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
    expect((body.error as Record<string, unknown>).message).toBe('An unexpected error occurred');
    expect(tracker.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        requestId: 'req-test',
        userId: 'u-1',
        tenantId: 't-1',
      }),
    );
  });

  it('handles non-Error throwables by wrapping in a synthetic Error', () => {
    const filter = new GlobalExceptionFilter(ctx, tracker);
    const { host, res } = buildHost();
    filter.catch('plain string', host);
    expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = res.jsonBody as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe(ErrorCode.UNKNOWN_ERROR);
    expect(tracker.captureException).toHaveBeenCalled();
    const reportedErr = (tracker.captureException.mock.calls[0] ?? [])[0] as Error;
    expect(reportedErr.message).toContain('plain string');
  });

  it('uses BusinessException.code directly for domain errors', () => {
    const filter = new GlobalExceptionFilter(ctx, tracker);
    const { host, res } = buildHost();
    filter.catch(new DomainNotFoundException('Product', 'p-1'), host);
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    const body = res.jsonBody as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe(ErrorCode.NOT_FOUND);
    expect((body.error as Record<string, unknown>).message).toBe('Product not found (id: p-1)');
    expect(tracker.captureException).not.toHaveBeenCalled();
  });

  it('escalates 5xx HttpExceptions to the tracker', () => {
    const filter = new GlobalExceptionFilter(ctx, tracker);
    const { host } = buildHost();
    const ex = new HttpException({ message: 'gateway dead' }, HttpStatus.BAD_GATEWAY);
    filter.catch(ex, host);
    expect(tracker.captureException).toHaveBeenCalledWith(ex, expect.any(Object));
  });

  it('works without an error tracker bound (Optional)', () => {
    const filter = new GlobalExceptionFilter(ctx);
    const { host, res } = buildHost();
    filter.catch(new Error('no tracker present'), host);
    expect(res.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('5xx BusinessException is reported, 4xx BusinessException is not', () => {
    const filter = new GlobalExceptionFilter(ctx, tracker);
    const { host: h4 } = buildHost();
    filter.catch(new BusinessException(ErrorCode.VALIDATION_ERROR, 'nope'), h4);
    expect(tracker.captureException).not.toHaveBeenCalled();

    const { host: h5 } = buildHost();
    filter.catch(new BusinessException(ErrorCode.DATABASE_ERROR, 'down'), h5);
    expect(tracker.captureException).toHaveBeenCalledTimes(1);
  });
});
