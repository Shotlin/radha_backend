import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { ClsModule, ClsService } from 'nestjs-cls';
import { validate as isUuid, v4 as uuid } from 'uuid';

import {
  CORRELATION_ID_HEADER,
  CorrelationIdMiddleware,
  registerOtelActiveSpanAccessor,
} from '../middleware/correlation-id.middleware';

/**
 * Builds a minimal Express request/response pair tight enough for
 * the middleware contract. We track every `setHeader` call so the
 * "echoes the response header" assertion is straightforward.
 */
function buildReqRes(headers: Record<string, string | string[] | undefined> = {}) {
  const req = { headers } as unknown as Request;
  const setHeader = jest.fn();
  const res = { setHeader } as unknown as Response;
  return { req, res, setHeader };
}

describe('CorrelationIdMiddleware', () => {
  let middleware: CorrelationIdMiddleware;
  let cls: ClsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot()],
      providers: [CorrelationIdMiddleware],
    }).compile();
    middleware = moduleRef.get(CorrelationIdMiddleware);
    cls = moduleRef.get(ClsService);
    // Ensure tests don't leak the OTel hook between cases.
    registerOtelActiveSpanAccessor(undefined);
  });

  it('uses an inbound valid UUID v4 verbatim', async () => {
    const incoming = uuid();
    const { req, res } = buildReqRes({ [CORRELATION_ID_HEADER]: incoming });
    const next = jest.fn() as unknown as NextFunction;

    await cls.run({}, () => {
      middleware.use(req, res, next);
    });

    expect(req.headers[CORRELATION_ID_HEADER]).toBe(incoming);
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', incoming);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a new UUID v4 when the header is missing', async () => {
    const { req, res } = buildReqRes({});
    const next = jest.fn() as unknown as NextFunction;

    await cls.run({}, () => {
      middleware.use(req, res, next);
    });

    const generated = req.headers[CORRELATION_ID_HEADER];
    expect(typeof generated).toBe('string');
    expect(isUuid(generated as string)).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('discards an invalid inbound value and generates a fresh UUID v4', async () => {
    const { req, res } = buildReqRes({ [CORRELATION_ID_HEADER]: 'not-a-uuid-at-all' });
    const next = jest.fn() as unknown as NextFunction;

    await cls.run({}, () => {
      middleware.use(req, res, next);
    });

    const replacement = req.headers[CORRELATION_ID_HEADER];
    expect(replacement).not.toBe('not-a-uuid-at-all');
    expect(typeof replacement).toBe('string');
    expect(isUuid(replacement as string)).toBe(true);
  });

  it('always sets the X-Correlation-Id response header to the canonical value', async () => {
    const incoming = uuid();
    const { req, res, setHeader } = buildReqRes({ [CORRELATION_ID_HEADER]: incoming });
    const next = jest.fn() as unknown as NextFunction;

    await cls.run({}, () => {
      middleware.use(req, res, next);
    });

    // Header echoed back, exactly once.
    expect(setHeader).toHaveBeenCalledWith('X-Correlation-Id', incoming);
    expect(setHeader).toHaveBeenCalledTimes(1);
  });

  it('writes the correlation id into the CLS store for downstream consumers', async () => {
    const incoming = uuid();
    const { req, res } = buildReqRes({ [CORRELATION_ID_HEADER]: incoming });
    const next = jest.fn() as unknown as NextFunction;

    await cls.run({}, () => {
      middleware.use(req, res, next);
      expect(cls.get('correlationId')).toBe(incoming);
    });
  });
});
