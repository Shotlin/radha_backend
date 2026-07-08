import type { JwtService } from '@nestjs/jwt';

import { ErrorCode } from '@/common/errors/error-codes';
import type { ConfigService } from '@/config/config.service';
import type { ImpersonationSessionRow } from '@/db/schema/impersonation';
import type { UserRow } from '@/db/schema/users';
import type { SessionsRepository } from '@/modules/auth/repositories/sessions.repository';
import type { UsersRepository } from '@/modules/auth/repositories/users.repository';
import type { AuditLogService } from '@/observability/audit-log.service';

import type { StartImpersonationDto } from '../dto/start-impersonation.dto';
import type { ImpersonationActionsRepository } from '../repositories/impersonation-actions.repository';
import type { ImpersonationSessionsRepository } from '../repositories/impersonation-sessions.repository';
import { AdminImpersonationService } from '../services/admin-impersonation.service';
import { IMPERSONATION_TOKEN_TTL_SECONDS } from '../types/impersonation.types';

/**
 * BE-53 — `AdminImpersonationService` unit tests.
 *
 * Covers:
 *   - admin role required to start,
 *   - self-impersonation rejected,
 *   - target user must exist,
 *   - session row is persisted with the supplied reason,
 *   - JWT is minted with `impersonation: true` and the correct claims,
 *   - audit log is written on start AND end (GRANT_ACCESS + REVOKE_ACCESS),
 *   - end with no active session returns null (controller maps to 404),
 *   - end stamps `ended_at` and the manual reason,
 *   - listAudit returns ISO-formatted rows.
 */

const STAFF_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_ID = '22222222-2222-2222-2222-222222222222';
const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const TENANT_ID = '44444444-4444-4444-4444-444444444444';

function makeSessionsRepo(
  overrides: Partial<jest.Mocked<ImpersonationSessionsRepository>> = {},
): jest.Mocked<ImpersonationSessionsRepository> {
  const base: jest.Mocked<ImpersonationSessionsRepository> = {
    create: jest.fn(),
    findById: jest.fn(),
    findActiveById: jest.fn(),
    findLatestActiveByStaff: jest.fn(),
    endSession: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ImpersonationSessionsRepository>;
  return Object.assign(base, overrides);
}

function makeActionsRepo(): jest.Mocked<ImpersonationActionsRepository> {
  return {
    create: jest.fn().mockResolvedValue(undefined),
    listBySession: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ImpersonationActionsRepository>;
}

function makeUsersRepo(
  override: Partial<UserRow> | null = {
    id: TARGET_ID,
    tenantId: TENANT_ID,
    role: 'owner',
  } as Partial<UserRow>,
): jest.Mocked<UsersRepository> {
  return {
    findById: jest.fn().mockResolvedValue(override),
  } as unknown as jest.Mocked<UsersRepository>;
}

function makeJwt(): jest.Mocked<JwtService> {
  return {
    signAsync: jest.fn().mockResolvedValue('signed-token'),
    verify: jest.fn(),
  } as unknown as jest.Mocked<JwtService>;
}

function makeConfig(): ConfigService {
  return {
    jwt: {
      accessTokenSecret: 'test-secret',
      refreshTokenSecret: 'test-refresh',
      accessTokenExpirySeconds: 900,
      refreshTokenExpirySeconds: 86400,
      issuer: 'radha',
      audience: 'radha-mobile',
    },
  } as unknown as ConfigService;
}

function makeAudit(): jest.Mocked<AuditLogService> {
  return {
    logAction: jest.fn().mockResolvedValue(undefined),
    logBatch: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AuditLogService>;
}

function makeUserSessions(): jest.Mocked<SessionsRepository> {
  return {
    revoke: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SessionsRepository>;
}

function makeService(opts: {
  sessions?: jest.Mocked<ImpersonationSessionsRepository>;
  actions?: jest.Mocked<ImpersonationActionsRepository>;
  users?: jest.Mocked<UsersRepository>;
  jwt?: jest.Mocked<JwtService>;
  config?: ConfigService;
  audit?: jest.Mocked<AuditLogService>;
  userSessions?: jest.Mocked<SessionsRepository>;
} = {}) {
  const sessions = opts.sessions ?? makeSessionsRepo();
  const actions = opts.actions ?? makeActionsRepo();
  const users = opts.users ?? makeUsersRepo();
  const jwt = opts.jwt ?? makeJwt();
  const config = opts.config ?? makeConfig();
  const audit = opts.audit ?? makeAudit();
  const userSessions = opts.userSessions ?? makeUserSessions();
  const service = new AdminImpersonationService(
    sessions,
    actions,
    users,
    jwt,
    config,
    audit,
    userSessions,
  );
  return { service, sessions, actions, users, jwt, audit, userSessions };
}

const validDto: StartImpersonationDto = {
  targetUserId: TARGET_ID,
  reason: 'Diagnosing a billing issue reported by the tenant owner.',
};

const sampleSessionRow = (overrides: Partial<ImpersonationSessionRow> = {}): ImpersonationSessionRow => ({
  id: SESSION_ID,
  staffUserId: STAFF_ID,
  impersonatedUserId: TARGET_ID,
  reason: validDto.reason,
  startedAt: new Date('2024-05-01T10:00:00Z'),
  expiresAt: new Date('2024-05-01T11:00:00Z'),
  endedAt: null,
  endedReason: null,
  ...overrides,
});

describe('AdminImpersonationService', () => {
  describe('start', () => {
    it('creates a session, mints a 60-min JWT, and writes audit', async () => {
      const sessions = makeSessionsRepo({
        create: jest.fn().mockResolvedValue(sampleSessionRow()),
      });
      const { service, jwt, audit } = makeService({ sessions });

      const result = await service.start(STAFF_ID, 'admin', validDto, {
        ipAddress: '10.0.0.1',
        userAgent: 'jest',
      });

      expect(sessions.create).toHaveBeenCalledWith({
        staffUserId: STAFF_ID,
        impersonatedUserId: TARGET_ID,
        reason: validDto.reason,
      });
      expect(jwt.signAsync).toHaveBeenCalledTimes(1);
      const [payload, signOpts] = jwt.signAsync.mock.calls[0];
      expect(payload).toMatchObject({
        sub: TARGET_ID,
        tenantId: TENANT_ID,
        role: 'owner',
        sessionId: SESSION_ID,
        impersonatorUserId: STAFF_ID,
        impersonationSessionId: SESSION_ID,
        impersonation: true,
      });
      expect(signOpts).toMatchObject({
        secret: 'test-secret',
        expiresIn: IMPERSONATION_TOKEN_TTL_SECONDS,
        issuer: 'radha',
        audience: 'radha-mobile',
      });

      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'GRANT_ACCESS',
          resourceType: 'impersonation_session',
          resourceId: SESSION_ID,
          userId: STAFF_ID,
          ipAddress: '10.0.0.1',
          userAgent: 'jest',
          success: true,
        }),
      );

      expect(result.sessionId).toBe(SESSION_ID);
      expect(result.accessToken).toBe('signed-token');
      expect(result.expiresIn).toBe(IMPERSONATION_TOKEN_TTL_SECONDS);
      expect(result.impersonatedUserId).toBe(TARGET_ID);
      expect(result.staffUserId).toBe(STAFF_ID);
    });

    it('rejects non-admin staff with ROLE_REQUIRED', async () => {
      const { service, sessions } = makeService();
      await expect(service.start(STAFF_ID, 'manager', validDto)).rejects.toMatchObject({
        code: ErrorCode.ROLE_REQUIRED,
      });
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('refuses self-impersonation', async () => {
      const { service, sessions } = makeService();
      await expect(
        service.start(STAFF_ID, 'admin', { ...validDto, targetUserId: STAFF_ID }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('returns USER_NOT_FOUND when the target user does not exist', async () => {
      const users = makeUsersRepo(null);
      const { service, sessions } = makeService({ users });
      await expect(service.start(STAFF_ID, 'admin', validDto)).rejects.toMatchObject({
        code: ErrorCode.USER_NOT_FOUND,
      });
      expect(sessions.create).not.toHaveBeenCalled();
    });
  });

  describe('endCurrent', () => {
    it('stamps ended_at, revokes the user_sessions row, and writes audit', async () => {
      const sessions = makeSessionsRepo({
        findLatestActiveByStaff: jest.fn().mockResolvedValue(sampleSessionRow()),
        endSession: jest.fn().mockResolvedValue(
          sampleSessionRow({ endedAt: new Date('2024-05-01T10:30:00Z'), endedReason: 'manual_end' }),
        ),
      });
      const userSessions = makeUserSessions();
      const audit = makeAudit();
      const { service } = makeService({ sessions, userSessions, audit });

      const result = await service.endCurrent(STAFF_ID, { ipAddress: '10.0.0.2' });

      expect(sessions.endSession).toHaveBeenCalledWith(SESSION_ID, 'manual_end');
      expect(userSessions.revoke).toHaveBeenCalledWith(SESSION_ID, 'admin');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REVOKE_ACCESS',
          resourceType: 'impersonation_session',
          resourceId: SESSION_ID,
          userId: STAFF_ID,
          ipAddress: '10.0.0.2',
          success: true,
        }),
      );
      expect(result).toEqual({
        sessionId: SESSION_ID,
        endedAt: '2024-05-01T10:30:00.000Z',
      });
    });

    it('returns null when there is no active session for the staff member', async () => {
      const sessions = makeSessionsRepo({
        findLatestActiveByStaff: jest.fn().mockResolvedValue(null),
      });
      const { service, audit } = makeService({ sessions });

      const result = await service.endCurrent(STAFF_ID);

      expect(result).toBeNull();
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('does not throw if user_sessions revoke fails — impersonation tokens are stateless', async () => {
      const sessions = makeSessionsRepo({
        findLatestActiveByStaff: jest.fn().mockResolvedValue(sampleSessionRow()),
        endSession: jest.fn().mockResolvedValue(
          sampleSessionRow({ endedAt: new Date('2024-05-01T10:30:00Z'), endedReason: 'manual_end' }),
        ),
      });
      const userSessions = makeUserSessions();
      userSessions.revoke.mockRejectedValueOnce(new Error('not found'));
      const { service } = makeService({ sessions, userSessions });

      const result = await service.endCurrent(STAFF_ID);
      expect(result?.sessionId).toBe(SESSION_ID);
    });
  });

  describe('listAudit', () => {
    it('returns ISO-formatted session rows from the repository', async () => {
      const row = sampleSessionRow({
        endedAt: new Date('2024-05-01T10:30:00Z'),
        endedReason: 'manual_end',
      });
      const sessions = makeSessionsRepo({
        list: jest.fn().mockResolvedValue([row]),
      });
      const { service } = makeService({ sessions });

      const out = await service.listAudit({ staffUserId: STAFF_ID, limit: 10 });

      expect(sessions.list).toHaveBeenCalledWith({ staffUserId: STAFF_ID, limit: 10 });
      expect(out).toEqual([
        {
          id: SESSION_ID,
          staffUserId: STAFF_ID,
          impersonatedUserId: TARGET_ID,
          reason: validDto.reason,
          startedAt: '2024-05-01T10:00:00.000Z',
          expiresAt: '2024-05-01T11:00:00.000Z',
          endedAt: '2024-05-01T10:30:00.000Z',
          endedReason: 'manual_end',
        },
      ]);
    });
  });

  describe('recordAction', () => {
    it('forwards to the actions repository', async () => {
      const actions = makeActionsRepo();
      const { service } = makeService({ actions });

      await service.recordAction({
        sessionId: SESSION_ID,
        requestPath: '/api/v1/products',
        requestMethod: 'GET',
        responseStatus: 200,
      });

      expect(actions.create).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        requestPath: '/api/v1/products',
        requestMethod: 'GET',
        responseStatus: 200,
      });
    });
  });
});
