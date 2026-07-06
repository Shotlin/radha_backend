import type { Request } from 'express';

import type { ImpersonationSessionRow } from '@/db/schema/impersonation';

/**
 * BE-53 — Shared types for the impersonation module.
 */

/** 60 minutes in seconds — matches the SQL `expires_at` default. */
export const IMPERSONATION_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * JWT payload shape for an impersonation access token.
 *
 * The claims on top of the regular `AccessTokenPayload`:
 *   - `impersonation: true`        — quick discriminator for guards.
 *   - `impersonatorUserId`         — the staff member who opened it.
 *   - `impersonationSessionId`     — DB row id; resolves to a session.
 */
export interface ImpersonationTokenPayload {
  sub: string;
  tenantId: string | null;
  role: string;
  sessionId: string;
  impersonatorUserId: string;
  impersonationSessionId: string;
  impersonation: true;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

/**
 * Decorate the Express `Request` with the resolved impersonation
 * session. Set by `ImpersonationActionLoggerMiddleware` after the
 * JWT auth guard runs; consumed by `ImpersonationGuard` and the
 * action-logger flush step.
 */
export interface ImpersonationRequestExtension {
  impersonationSession?: ImpersonationSessionRow;
}

export type ImpersonatedRequest = Request & ImpersonationRequestExtension;
