import {
  ConflictException,
  Injectable,
  Logger,
  NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import { IdempotencyService } from '../services/idempotency.service';

/**
 * BE-44 — `Idempotency-Key` middleware.
 *
 * Behaviour:
 *   - Skipped on non-mutating methods (GET / HEAD / OPTIONS).
 *   - Skipped when the client did not send `Idempotency-Key`.
 *   - On hit with a matching `request_hash` → replay the original
 *     status + body and short-circuit the controller chain.
 *   - On hit with a different `request_hash` → 409 Conflict.
 *   - On miss → pass through, then capture the controller's response
 *     in `res.on('finish')` and persist asynchronously (best-effort).
 *
 * Order of registration (set up by the importing module):
 *   1. ClsMiddleware / RequestIdMiddleware — request id available.
 *   2. AuthN — `req.user` populated.
 *   3. IdempotencyMiddleware — needs `req.user.id` to scope the record.
 *   4. Route handlers.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEADER_NAME = 'idempotency-key';
const MAX_KEY_LENGTH = 128;

@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(IdempotencyMiddleware.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
      return next();
    }

    const rawKey = req.headers[HEADER_NAME];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || typeof key !== 'string') return next();

    const trimmed = key.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) {
      // Malformed key — let the request proceed without idempotency.
      // We deliberately don't 400 here so a buggy client header doesn't
      // brick all writes.
      return next();
    }

    const requestHash = this.idempotency.hashRequest({
      method: req.method,
      path: req.baseUrl + req.path,
      body: (req as Request & { body?: unknown }).body,
    });

    let cached;
    try {
      cached = await this.idempotency.lookup(trimmed);
    } catch (err) {
      // Cache lookup failure should not block the mutation — log and
      // proceed as if it were a miss.
      this.logger.warn(`Idempotency lookup failed: ${(err as Error).message}`);
      cached = null;
    }

    if (cached) {
      if (cached.requestHash !== requestHash) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSE',
          message: 'Idempotency-Key reused with a different request payload',
        });
      }
      res.status(cached.responseStatus).json(cached.responseBody);
      return;
    }

    // Cache miss — capture the response on its way out and persist.
    const userId = this.resolveUserId(req);
    if (!userId) {
      // Without an authenticated user we can't scope the record. The
      // mutation may still be allowed (e.g. anonymous lead capture);
      // skip idempotency in that case.
      return next();
    }

    const chunks: Buffer[] = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    // Capture response body chunks so we can replay them later.
    (res as Response).write = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(toBuffer(chunk));
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as Response['write'];

    (res as Response).end = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(toBuffer(chunk));
      return (originalEnd as (...args: unknown[]) => Response)(chunk, ...rest);
    }) as Response['end'];

    res.on('finish', () => {
      // Only cache successful responses — replaying a 5xx is rarely
      // what the client wants. 2xx and 3xx are persisted; 4xx and 5xx
      // are skipped so the client can retry with corrections.
      const status = res.statusCode;
      if (status >= 400) return;

      const body = parseBody(chunks);
      void this.idempotency
        .persist({
          key: trimmed,
          userId,
          requestHash,
          response: { status, body },
        })
        .catch((err) => {
          this.logger.warn(
            `Idempotency persist failed key=${trimmed}: ${(err as Error).message}`,
          );
        });
    });

    next();
  }

  private resolveUserId(req: Request): string | null {
    const user = (req as Request & { user?: AuthenticatedUser }).user;
    if (user && typeof user.id === 'string' && user.id.length > 0) {
      return user.id;
    }
    return null;
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function parseBody(chunks: Buffer[]): unknown {
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON response (e.g. a redirect HTML body) — store as a string
    // so replay still produces *something* useful.
    return text;
  }
}
