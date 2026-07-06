import { z } from 'zod';

/**
 * BE-53 — `POST /api/v1/admin/impersonate` request DTO.
 *
 * Validation rules:
 *   - `targetUserId` must be a UUID (the user being impersonated).
 *   - `reason` is mandatory, min 10 / max 500 chars. Mirrors the
 *     `impersonation_reason_min` SQL CHECK so a bad payload never
 *     even reaches the database.
 */
export const StartImpersonationSchema = z.object({
  targetUserId: z.string().uuid(),
  reason: z.string().min(10).max(500),
});

export type StartImpersonationDto = z.infer<typeof StartImpersonationSchema>;

/**
 * Response shape for a freshly-started impersonation session. The
 * caller stores `accessToken` and uses it for the duration; the DB
 * row id is also returned so the staff UI can poll its own audit
 * history.
 */
export interface StartImpersonationResponse {
  sessionId: string;
  accessToken: string;
  expiresAt: string;
  expiresIn: number;
  staffUserId: string;
  impersonatedUserId: string;
}

/**
 * Public view of a session row used by the audit-list endpoint.
 * Reason is included verbatim — staff already saw it when opening
 * the session, and it's exactly what compliance review needs.
 */
export interface ImpersonationSessionAuditDto {
  id: string;
  staffUserId: string;
  impersonatedUserId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
}
