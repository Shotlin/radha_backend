import { ConflictException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';

import type { IdempotencyRecordRow } from '@/db/schema/idempotency-records';

import { IdempotencyMiddleware } from '../middleware/idempotency.middleware';
import { IdempotencyService } from '../services/idempotency.service';

/**
 * BE-44 — `IdempotencyMiddleware` unit tests.
 *
 * The middleware sits between AuthN and the route handlers. We drive
 * it with a hand-rolled Express-compatible request/response pair so we
 * can:
 *   - assert pass-through on non-mutating verbs and missing keys,
 *   - assert cache-hit replay (status + body restored verbatim),
 *   - assert hash-mismatch raises 409,
 *   - assert miss-then-capture path persists via `IdempotencyService`
 *     after `res.on('finish')` fires.
 */

interface MockResponse {
  statusCode: number;
  status: jest.Mock;
  json: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  on: Response['on'];
  emit: (event: string) => boolean;
  _emitFinish: () => void;
}

describe('IdempotencyMiddleware', () => {
  let service: jest.Mocked<IdempotencyService>;
  let middleware: IdempotencyMiddleware;

  const userId = 'user-aaaaaaaa';
  const idemKey = 'idem-key-12345678';

  beforeEach(() => {
    service = {
      hashRequest: jest.fn().mockReturnValue('hash-AAA'),
      lookup: jest.fn(),
      persist: jest.fn().mockResolvedValue({ key: idemKey } as IdempotencyRecordRow),
    } as unknown as jest.Mocked<IdempotencyService>;

    middleware = new IdempotencyMiddleware(service);
  });

  function buildRequest(overrides: Partial<Request> = {}): Request {
    const base = {
      method: 'POST',
      headers: { 'idempotency-key': idemKey } as Record<string, string | string[] | undefined>,
      baseUrl: '/api/v1',
      path: '/sync/scans',
      body: { items: [{ idempotencyKey: idemKey, payload: { id: 'a' } }] },
      user: { id: userId },
    };
    return { ...base, ...overrides } as unknown as Request;
  }

  function buildResponse(): MockResponse {
    const emitter = new EventEmitter();
    const res: MockResponse = {
      statusCode: 200,
      status: jest.fn(),
      json: jest.fn(),
      write: jest.fn().mockReturnValue(true),
      end: jest.fn(),
      on: emitter.on.bind(emitter) as Response['on'],
      emit: emitter.emit.bind(emitter),
      _emitFinish: () => emitter.emit('finish'),
    };

    res.status.mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json.mockImplementation(() => res);
    res.end.mockImplementation(() => res);

    return res;
  }

  function asResponse(res: MockResponse): Response {
    return res as unknown as Response;
  }

  it('skips non-mutating methods', async () => {
    const req = buildRequest({ method: 'GET' });
    const res = buildResponse();
    const next = jest.fn();

    await middleware.use(req, asResponse(res), next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it('skips when no Idempotency-Key header is present', async () => {
    const req = buildRequest({ headers: {} });
    const res = buildResponse();
    const next = jest.fn();

    await middleware.use(req, asResponse(res), next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it('skips when key is empty or absurdly long', async () => {
    const next1 = jest.fn();
    await middleware.use(
      buildRequest({ headers: { 'idempotency-key': '   ' } }),
      asResponse(buildResponse()),
      next1 as NextFunction,
    );
    expect(next1).toHaveBeenCalled();
    expect(service.lookup).not.toHaveBeenCalled();

    const next2 = jest.fn();
    await middleware.use(
      buildRequest({ headers: { 'idempotency-key': 'x'.repeat(500) } }),
      asResponse(buildResponse()),
      next2 as NextFunction,
    );
    expect(next2).toHaveBeenCalled();
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it('replays cached response on key + matching hash', async () => {
    service.lookup.mockResolvedValue({
      key: idemKey,
      userId,
      requestHash: 'hash-AAA',
      responseStatus: 201,
      responseBody: { ok: true, id: 'cached-id' },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    } as IdempotencyRecordRow);

    const req = buildRequest();
    const res = buildResponse();
    const next = jest.fn();

    await middleware.use(req, asResponse(res), next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ ok: true, id: 'cached-id' });
    expect(service.persist).not.toHaveBeenCalled();
  });

  it('throws 409 ConflictException on key reuse with a different payload hash', async () => {
    service.lookup.mockResolvedValue({
      key: idemKey,
      userId,
      requestHash: 'hash-DIFFERENT',
      responseStatus: 200,
      responseBody: { ok: true },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    } as IdempotencyRecordRow);

    const req = buildRequest();
    const res = buildResponse();
    const next = jest.fn();

    await expect(
      middleware.use(req, asResponse(res), next as NextFunction),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(next).not.toHaveBeenCalled();
    expect(service.persist).not.toHaveBeenCalled();
  });

  it('passes through on miss and persists captured response on finish', async () => {
    service.lookup.mockResolvedValue(null);

    const req = buildRequest();
    const res = buildResponse();
    const next = jest.fn();

    await middleware.use(req, asResponse(res), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);

    // Simulate the controller writing a JSON response and Express
    // emitting `finish`.
    res.statusCode = 200;
    res.write(Buffer.from(JSON.stringify({ ok: true, id: 'new-id' })));
    res.end();
    res._emitFinish();

    // `persist` is fired as a fire-and-forget — give the microtask
    // queue a tick to flush.
    await new Promise((r) => setImmediate(r));

    expect(service.persist).toHaveBeenCalledTimes(1);
    const persistArgs = service.persist.mock.calls[0][0];
    expect(persistArgs).toMatchObject({
      key: idemKey,
      userId,
      requestHash: 'hash-AAA',
      response: { status: 200 },
    });
    expect(persistArgs.response.body).toEqual({ ok: true, id: 'new-id' });
  });

  it('does not persist 4xx/5xx responses', async () => {
    service.lookup.mockResolvedValue(null);

    const req = buildRequest();
    const res = buildResponse();
    const next = jest.fn();

    await middleware.use(req, asResponse(res), next as NextFunction);

    res.statusCode = 422;
    res.write(Buffer.from(JSON.stringify({ ok: false })));
    res.end();
    res._emitFinish();

    await new Promise((r) => setImmediate(r));
    expect(service.persist).not.toHaveBeenCalled();
  });

  it('skips when the request is unauthenticated (no req.user)', async () => {
    service.lookup.mockResolvedValue(null);

    const req = buildRequest({ user: undefined } as unknown as Partial<Request>);
    const res = buildResponse();
    const next = jest.fn();

    await middleware.use(req, asResponse(res), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);

    res.statusCode = 200;
    res.write(Buffer.from('{}'));
    res.end();
    res._emitFinish();

    await new Promise((r) => setImmediate(r));
    expect(service.persist).not.toHaveBeenCalled();
  });

  it('treats lookup errors as a miss and lets the request proceed', async () => {
    service.lookup.mockRejectedValueOnce(new Error('db blip'));

    const req = buildRequest();
    const res = buildResponse();
    const next = jest.fn();

    await middleware.use(req, asResponse(res), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
