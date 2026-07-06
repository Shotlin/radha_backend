import { Injectable, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { ImpersonationSessionRow } from '@/db/schema/impersonation';
import { UsersRepository } from '@/modules/auth/repositories/users.repository';
import { SessionsRepository } from '@/modules/auth/repositories/sessions.repository';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  ImpersonationSessionAuditDto,
  StartImpersonationDto,
  StartImpersonationResponse,
} from '../dto/start-impersonation.dto';
import {
  IMPERSONATION_TOKEN_TTL_SECONDS,
  ImpersonationTokenPayload,
} from '../types/impersonation.types';
import { ImpersonationActionsRepository } from '../repositories/impersonation-actions.repository';
import { ImpersonationSessionsRepository } from '../repositories/impersonation-sessions.repository';

/**
 * BE-53 — Admin impersonation orchestrator.
 *
 * Responsibilities:
 *   - **Start**: validate the staff caller has the `admin` role,
 *     verify the target user exists, write a session row, and mint
 *     a short-lived (60 minute) JWT carrying the
 *     `impersonationSessionId` + `impersonatorUserId` claims.
 *   - **End**: stamp `ended_at` on the active session, revoke the
 *     parallel `user_sessions` row when one exists, and write an
 *     audit log entry.
 *   - **Audit list**: thin wrapper over the repository, exposed by
 *     the controller for the admin dashboard.
 *
 * The guard, middleware, and controller don't talk to the database
 * directly — they all go through this service so the audit story
 * stays coherent.
 */
@Injectable()
export class AdminImpersonationService {
  constructor(
    private readonly sessions: ImpersonationSessionsRepository,
    private readonly actions: ImpersonationActionsRepository,
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditLogService,
    @Optional() private readonly userSessions?: SessionsRepository,
  ) {}

  /**
   * Open a new impersonation session.
   *
   * The DTO has already been validated (Zod) by the controller pipe;
   * we still reject self-impersonation here because the schema can't
   * see the staff id.
   */
  async start(
    staffUserId: string,
    staffRole: string,
    dto: StartImpersonationDto,
    requestMeta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<StartImpersonationResponse> {
    if (staffRole !== 'admin') {
      throw new BusinessException(
        ErrorCode.ROLE_REQUIRED,
        'Admin role required to impersonate',
      );
    }
    if (dto.targetUserId === staffUserId) {
      throw new BusinessException(
        ErrorCode.INVALID_INPUT,
        'You cannot impersonate yourself',
      );
    }

    const target = await this.users.findById(dto.targetUserId);
    if (!target) {
      throw new BusinessException(ErrorCode.USER_NOT_FOUND, 'Target user not found', {
        metadata: { targetUserId: dto.targetUserId },
      });
    }

    const row = await this.sessions.create({
      staffUserId,
      impersonatedUserId: dto.targetUserId,
      reason: dto.reason,
    });

    const accessToken = await this.mintToken(row, target.tenantId, target.role);

    await this.audit.logAction({
      action: 'GRANT_ACCESS',
      resourceType: 'impersonation_session',
      resourceId: row.id,
      userId: staffUserId,
      tenantId: target.tenantId ?? '',
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      success: true,
      metadata: {
        impersonatedUserId: dto.targetUserId,
        reason: dto.reason,
        expiresAt: row.expiresAt.toISOString(),
      },
    });

    return {
      sessionId: row.id,
      accessToken,
      expiresAt: row.expiresAt.toISOString(),
      expiresIn: IMPERSONATION_TOKEN_TTL_SECONDS,
      staffUserId,
      impersonatedUserId: dto.targetUserId,
    };
  }

  /**
   * End the staff member's most recent active session. The token
   * itself can't be invalidated cryptographically (it's a stateless
   * JWT), but every guard / middleware re-checks `ended_at IS NULL`
   * on each request, so once we stamp ended the token is dead in
   * practice within one request.
   */
  async endCurrent(
    staffUserId: string,
    requestMeta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<{ sessionId: string; endedAt: string } | null> {
    const active = await this.sessions.findLatestActiveByStaff(staffUserId);
    if (!active) return null;

    const ended = await this.sessions.endSession(active.id, 'manual_end');
    if (!ended) return null;

    // If the staff used a regular user_sessions row in parallel
    // (admin login flow), revoke it as well so any cached refresh
    // can't ride on. Optional repo: tests can omit it.
    if (this.userSessions) {
      try {
        await this.userSessions.revoke(active.id, 'admin');
      } catch {
        // user_sessions row may not exist — impersonation tokens are
        // stateless and don't require a sessions row to function.
      }
    }

    await this.audit.logAction({
      action: 'REVOKE_ACCESS',
      resourceType: 'impersonation_session',
      resourceId: active.id,
      userId: staffUserId,
      tenantId: '',
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      success: true,
      metadata: {
        impersonatedUserId: active.impersonatedUserId,
        endedReason: 'manual_end',
      },
    });

    return {
      sessionId: ended.id,
      endedAt: ended.endedAt!.toISOString(),
    };
  }

  /** Returns true while a session is live (not ended, not expired). */
  async getActiveSession(sessionId: string): Promise<ImpersonationSessionRow | null> {
    return this.sessions.findActiveById(sessionId);
  }

  /** Persist a single per-request action row. Best-effort. */
  async recordAction(input: {
    sessionId: string;
    requestPath: string;
    requestMethod: string;
    responseStatus: number;
  }): Promise<void> {
    await this.actions.create({
      sessionId: input.sessionId,
      requestPath: input.requestPath,
      requestMethod: input.requestMethod,
      responseStatus: input.responseStatus,
    });
  }

  /** Audit listing for `GET /api/v1/admin/impersonations/audit`. */
  async listAudit(
    options: { staffUserId?: string; impersonatedUserId?: string; limit?: number } = {},
  ): Promise<ImpersonationSessionAuditDto[]> {
    const rows = await this.sessions.list(options);
    return rows.map((r) => ({
      id: r.id,
      staffUserId: r.staffUserId,
      impersonatedUserId: r.impersonatedUserId,
      reason: r.reason,
      startedAt: r.startedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      endedReason: r.endedReason,
    }));
  }

  /**
   * Sign the impersonation JWT.
   *
   * Claims:
   *   - `sub`            — the impersonated user (so downstream
   *                        services see the right tenant context),
   *   - `tenantId`/`role`/`sessionId` mirror the BE-06 access token
   *                        shape so existing guards keep working,
   *   - `impersonatorUserId` flags the token as an impersonation
   *                        token. `ImpersonationGuard` keys off this.
   *   - `impersonationSessionId` resolves back to the DB row.
   *
   * Signed with the standard access-token secret so the existing
   * `JwtAuthGuard` accepts it transparently — the impersonation
   * guard layers on top to enforce destructive-action rules.
   */
  private async mintToken(
    session: ImpersonationSessionRow,
    targetTenantId: string | null,
    targetRole: string,
  ): Promise<string> {
    const payload: ImpersonationTokenPayload = {
      sub: session.impersonatedUserId,
      tenantId: targetTenantId,
      role: targetRole,
      sessionId: session.id,
      impersonatorUserId: session.staffUserId,
      impersonationSessionId: session.id,
      impersonation: true,
    };

    const cfg = this.config.jwt;
    return this.jwt.signAsync(payload, {
      secret: cfg.accessTokenSecret,
      expiresIn: IMPERSONATION_TOKEN_TTL_SECONDS,
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
  }
}
