import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { JwtService } from '@nestjs/jwt';

import { ConfigService } from '@/config/config.service';

import { AdminImpersonationService } from '../services/admin-impersonation.service';
import {
  ImpersonatedRequest,
  ImpersonationTokenPayload,
} from '../types/impersonation.types';

/**
 * BE-53 — Per-request audit logger for impersonation sessions.
 *
 * Behaviour:
 *   1. Extract the bearer token. If absent or doesn't decode as an
 *      impersonation JWT, no-op so non-impersonated traffic flows
 *      through unchanged.
 *   2. Decode the token (without verifying — `JwtAuthGuard` does the
 *      cryptographic check). Resolve the live session row from the
 *      DB so an ended/expired session can't fake context.
 *   3. Stash the session on the request as `impersonationSession`
 *      so downstream guards / handlers see it.
 *   4. On `res.on('finish')`, write a single
 *      `impersonation_actions` row capturing method, path, and the
 *      final response status. Best-effort: failures are logged but
 *      never thrown back to the caller.
 *
 * The middleware runs early (before the JwtAuthGuard) because
 * Express middleware always fires before controller-bound guards.
 * That's fine — we never trust the decoded payload for authentication;
 * the `JwtAuthGuard` later in the pipeline still verifies the
 * signature and the `ImpersonationGuard` enforces destructive-action
 * policy. We only read claims here to know which session to log
 * against.
 */

const BEARER_RE = /^Bearer\s+(.+)$/i;

@Injectable()
export class ImpersonationActionLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ImpersonationActionLoggerMiddleware.name);

  constructor(
    private readonly service: AdminImpersonationService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async use(req: ImpersonatedRequest, res: Response, next: NextFunction): Promise<void> {
    const payload = this.tryDecode(req.headers['authorization']);
    if (!payload || !payload.impersonation) {
      return next();
    }

    let session = null as Awaited<ReturnType<AdminImpersonationService['getActiveSession']>>;
    try {
      session = await this.service.getActiveSession(payload.impersonationSessionId);
    } catch (err) {
      this.logger.warn(
        `impersonation session lookup failed: ${(err as Error).message}`,
      );
    }
    if (!session) return next();

    req.impersonationSession = session;

    res.on('finish', () => {
      const path = stripQuery(req.originalUrl || req.url || '');
      void this.service
        .recordAction({
          sessionId: session!.id,
          requestPath: path,
          requestMethod: (req.method || '').toUpperCase(),
          responseStatus: res.statusCode,
        })
        .catch((err) => {
          this.logger.warn(
            `impersonation action persist failed sessionId=${session!.id}: ${
              (err as Error).message
            }`,
          );
        });
    });

    next();
  }

  /**
   * Decode (NOT verify) the access token if it claims to be an
   * impersonation token. Returns null for absent/malformed/non-
   * impersonation tokens so the caller can short-circuit.
   *
   * Verification is the `JwtAuthGuard`'s job; we only need the
   * claims to look up the session. A forged token will still be
   * rejected by the guard, and the session row guard re-validates
   * `ended_at IS NULL`.
   */
  private tryDecode(
    header: string | string[] | undefined,
  ): ImpersonationTokenPayload | null {
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw || typeof raw !== 'string') return null;
    const m = BEARER_RE.exec(raw);
    if (!m) return null;
    try {
      // Use verify so an expired or tampered impersonation token
      // never gets to log against an active session. We use the
      // standard access secret because the service signs with it.
      const payload = this.jwt.verify<ImpersonationTokenPayload>(m[1].trim(), {
        secret: this.config.jwt.accessTokenSecret,
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
      });
      if (!payload || payload.impersonation !== true) return null;
      if (!payload.impersonationSessionId || !payload.impersonatorUserId) return null;
      return payload;
    } catch {
      return null;
    }
  }
}

function stripQuery(path: string): string {
  const idx = path.indexOf('?');
  return idx === -1 ? path : path.slice(0, idx);
}
