import { createHash } from 'node:crypto';

import { AuthService } from '../auth.service';
import * as otpUtils from '../utils/otp.utils';
import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

/** Mirrors AuthService's private hashToken() exactly — sha256 hex digest. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Phase 13 coverage for the Firebase Auth exchange, legacy-link recovery,
 * and the narrowed OTP paths. Mirrors `fcm.service.spec.ts`'s style:
 * direct construction with plain `jest.fn()` mocks, no Nest TestingModule
 * (these are pure unit tests of orchestration logic, not DI wiring).
 */

const baseUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  mobile: '9876543210',
  email: null,
  name: '',
  role: 'consumer',
  tenantId: null,
  firebaseUid: null,
  authProvider: 'otp',
  subscriptionTier: 'free_consumer',
  isVerified: false,
  isActive: true,
  lockedUntil: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

function buildService(overrides: Partial<Record<string, unknown>> = {}) {
  const config = {
    demoAccountsEnabled: true,
    sms: { otpLength: 6, otpExpirySeconds: 600 },
    isProduction: false,
    isStaging: false,
    jwt: { accessTokenExpirySeconds: 1800 },
  };
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const context = {};
  const audit = { logAction: jest.fn().mockResolvedValue(undefined) };
  const sms = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const jwt = {
    issueAccessToken: jest.fn().mockResolvedValue('access-token'),
    issueRefreshToken: jest.fn().mockResolvedValue('refresh-token'),
    verifyRefreshToken: jest.fn(),
  };
  const rateLimiter = { checkOtpRequest: jest.fn() };
  const sessions = {
    create: jest.fn().mockResolvedValue(undefined),
    findActive: jest.fn(),
    revoke: jest.fn(),
    revokeAllForUser: jest.fn(),
    rotate: jest.fn(),
  };
  const sessionsRepo = {};
  const users = {
    findByMobile: jest.fn().mockResolvedValue(null),
    findById: jest.fn(),
    findByFirebaseUid: jest.fn().mockResolvedValue(null),
    findByEmail: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
    findStoreIdsByUserId: jest.fn().mockResolvedValue([]),
  };
  const otpAttempts = {
    create: jest.fn().mockResolvedValue(undefined),
    findByRequestId: jest.fn(),
    markVerified: jest.fn().mockResolvedValue(undefined),
    markExpired: jest.fn().mockResolvedValue(undefined),
    incrementAttempt: jest.fn().mockResolvedValue(undefined),
  };
  const invitations = {
    findActiveByMobile: jest.fn().mockResolvedValue(null),
    markAccepted: jest.fn(),
  };
  const firebaseAuth = { verify: jest.fn() };

  const mocks = {
    config,
    logger,
    context,
    audit,
    sms,
    jwt,
    rateLimiter,
    sessions,
    sessionsRepo,
    users,
    otpAttempts,
    invitations,
    firebaseAuth,
    ...overrides,
  };

  const service = new AuthService(
    mocks.config as never,
    mocks.logger as never,
    mocks.context as never,
    mocks.audit as never,
    mocks.sms as never,
    mocks.jwt as never,
    mocks.rateLimiter as never,
    mocks.sessions as never,
    mocks.sessionsRepo as never,
    mocks.users as never,
    mocks.otpAttempts as never,
    mocks.invitations as never,
    mocks.firebaseAuth as never,
  );

  return { service, ...mocks };
}

describe('AuthService — Firebase Auth exchange (Phase 13)', () => {
  it('creates a new consumer for an unseen Firebase uid/email', async () => {
    const { service, users, firebaseAuth } = buildService();
    firebaseAuth.verify.mockResolvedValue({
      firebaseUid: 'fb-uid-new',
      email: 'new@example.com',
      emailVerified: true,
    });
    users.findByFirebaseUid.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(null);
    const created = baseUser({
      id: 'user-new',
      mobile: null,
      email: 'new@example.com',
      firebaseUid: 'fb-uid-new',
      authProvider: 'google',
    });
    users.create.mockResolvedValue(created);
    users.update.mockResolvedValue(created);

    const result = await service.exchangeFirebaseToken(
      { idToken: 'tok', deviceId: 'dev-1' },
      '127.0.0.1',
      'ua',
    );

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'consumer',
        firebaseUid: 'fb-uid-new',
        email: 'new@example.com',
        authProvider: 'google',
        isVerified: true,
      }),
    );
    expect(result.user.id).toBe('user-new');
    expect(result.accessToken).toBe('access-token');
  });

  it('links to an existing user by email match, preserving role/tenant', async () => {
    const { service, users, firebaseAuth } = buildService();
    firebaseAuth.verify.mockResolvedValue({
      firebaseUid: 'fb-uid-link',
      email: 'owner@example.com',
      emailVerified: true,
    });
    const existing = baseUser({
      id: 'user-owner',
      email: 'owner@example.com',
      role: 'owner',
      tenantId: 'tenant-1',
      authProvider: 'otp',
    });
    users.findByFirebaseUid.mockResolvedValue(null);
    users.findByEmail.mockResolvedValue(existing);
    const linked = { ...existing, firebaseUid: 'fb-uid-link', authProvider: 'google_linked' };
    users.update.mockResolvedValue(linked);

    const result = await service.exchangeFirebaseToken(
      { idToken: 'tok' },
      '127.0.0.1',
      'ua',
    );

    expect(users.update).toHaveBeenCalledWith(
      'user-owner',
      expect.objectContaining({ firebaseUid: 'fb-uid-link', authProvider: 'google_linked' }),
    );
    expect(users.create).not.toHaveBeenCalled();
    expect(result.user.role).toBe('owner');
    expect(result.user.tenantId).toBe('tenant-1');
  });

  it('logs straight in on a second call with the same already-linked uid', async () => {
    const { service, users, firebaseAuth } = buildService();
    firebaseAuth.verify.mockResolvedValue({
      firebaseUid: 'fb-uid-repeat',
      email: 'repeat@example.com',
      emailVerified: true,
    });
    const existing = baseUser({
      id: 'user-repeat',
      firebaseUid: 'fb-uid-repeat',
      authProvider: 'google',
    });
    users.findByFirebaseUid.mockResolvedValue(existing);

    const result = await service.exchangeFirebaseToken({ idToken: 'tok' }, '127.0.0.1', 'ua');

    expect(users.create).not.toHaveBeenCalled();
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(result.user.id).toBe('user-repeat');
  });

  it('rejects a tampered/expired Firebase token', async () => {
    const { service, firebaseAuth } = buildService();
    firebaseAuth.verify.mockRejectedValue(
      new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'Invalid or expired Google sign-in token'),
    );

    await expect(
      service.exchangeFirebaseToken({ idToken: 'bad' }, '127.0.0.1', 'ua'),
    ).rejects.toMatchObject({ code: ErrorCode.AUTHENTICATION_REQUIRED });
  });
});

describe('AuthService — legacy account link recovery (Phase 13)', () => {
  it('requestLegacyLink 404s for an unregistered mobile', async () => {
    const { service, users } = buildService();
    users.findByMobile.mockResolvedValue(null);

    await expect(service.requestLegacyLink('7000000000', '127.0.0.1')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('verifyLegacyLink links and preserves role/tenant', async () => {
    const { service, users, otpAttempts, firebaseAuth } = buildService();
    const existing = baseUser({
      id: 'user-legacy',
      mobile: '9876500000',
      role: 'manager',
      tenantId: 'tenant-9',
    });
    users.findByMobile.mockResolvedValue(existing);
    otpAttempts.findByRequestId.mockResolvedValue({
      id: 'attempt-1',
      requestId: 'req-1',
      mobile: '9876500000',
      otpHash: 'hash',
      attemptCount: 0,
      maxAttempts: 3,
      isVerified: false,
      isExpired: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // otp.utils.verifyOtp does a real bcrypt-style hash comparison; spy it
    // out so this test exercises the LINKING logic, not hashing.
    jest.spyOn(otpUtils, 'verifyOtp').mockResolvedValue(true);

    firebaseAuth.verify.mockResolvedValue({
      firebaseUid: 'fb-uid-legacy',
      email: null,
      emailVerified: false,
    });
    const linked = { ...existing, firebaseUid: 'fb-uid-legacy', authProvider: 'google_linked' };
    users.update.mockResolvedValue(linked);

    const result = await service.verifyLegacyLink(
      { mobile: '9876500000', otp: '123456', requestId: 'req-1', idToken: 'tok' },
      '127.0.0.1',
      'ua',
    );

    expect(users.update).toHaveBeenCalledWith(
      'user-legacy',
      expect.objectContaining({ firebaseUid: 'fb-uid-legacy', authProvider: 'google_linked' }),
    );
    expect(result.user.role).toBe('manager');
    expect(result.user.tenantId).toBe('tenant-9');

    jest.restoreAllMocks();
  });
});

describe('AuthService — requestOtp restriction (Phase 13)', () => {
  it('rejects an unregistered, non-demo mobile', async () => {
    const { service, users } = buildService();
    users.findByMobile.mockResolvedValue(null);

    await expect(
      service.requestOtp({ mobile: '7000000000', platform: 'mobile' }, '127.0.0.1'),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(users.findByMobile).toHaveBeenCalled();
  });

  it('still issues OTPs for the 3 demo accounts without an existing-user check', async () => {
    const { service, users } = buildService();

    for (const mobile of ['9999999999', '8000000000', '9724710944']) {
      users.findByMobile.mockClear();
      const result = await service.requestOtp({ mobile, platform: 'mobile' }, '127.0.0.1');
      expect(result.requestId).toBeDefined();
      expect(users.findByMobile).not.toHaveBeenCalled();
    }
  });

  it('does not block a registered, non-demo mobile', async () => {
    const { service, users } = buildService();
    users.findByMobile.mockResolvedValue(baseUser());

    const result = await service.requestOtp({ mobile: '9876543210', platform: 'mobile' }, '127.0.0.1');
    expect(result.requestId).toBeDefined();
  });
});

describe('AuthService — refreshTokens grace window (session-expiry fix)', () => {
  const buildSession = (overrides: Record<string, unknown> = {}) => ({
    id: 'session-1',
    userId: 'user-1',
    refreshTokenHash: hashToken('current-token'),
    previousRefreshTokenHash: hashToken('previous-token'),
    isActive: true,
    expiresAt: new Date(Date.now() + 60_000),
    lastUsedAt: new Date(),
    ...overrides,
  });

  it('rotates normally when the presented token matches the current hash', async () => {
    const { service, sessions, jwt, users } = buildService();
    jwt.verifyRefreshToken.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });
    sessions.findActive.mockResolvedValue(buildSession());
    users.findById.mockResolvedValue(baseUser({ id: 'user-1' }));

    await service.refreshTokens({ refreshToken: 'current-token' });

    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(sessions.rotate).toHaveBeenCalledWith(
      'session-1',
      hashToken('current-token'),
      expect.any(String),
    );
  });

  it('tolerates a replay of the immediately-previous token within the grace window (no revoke)', async () => {
    const { service, sessions, jwt, users } = buildService();
    jwt.verifyRefreshToken.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });
    sessions.findActive.mockResolvedValue(
      buildSession({ lastUsedAt: new Date(Date.now() - 2_000) }), // rotated 2s ago
    );
    users.findById.mockResolvedValue(baseUser({ id: 'user-1' }));

    const result = await service.refreshTokens({ refreshToken: 'previous-token' });

    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(result.accessToken).toBeDefined();
    // Chains off the CURRENT hash, not the stale presented one.
    expect(sessions.rotate).toHaveBeenCalledWith(
      'session-1',
      hashToken('current-token'),
      expect.any(String),
    );
  });

  it('treats a stale token presented outside the grace window as theft', async () => {
    const { service, sessions, jwt, users } = buildService();
    jwt.verifyRefreshToken.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });
    sessions.findActive.mockResolvedValue(
      buildSession({ lastUsedAt: new Date(Date.now() - 60_000) }), // rotated 60s ago — outside the 15s window
    );

    await expect(service.refreshTokens({ refreshToken: 'previous-token' })).rejects.toMatchObject({
      code: ErrorCode.TOKEN_REVOKED,
    });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1', 'token_theft');
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('treats a token matching neither current nor previous hash as theft', async () => {
    const { service, sessions, jwt } = buildService();
    jwt.verifyRefreshToken.mockResolvedValue({ sub: 'user-1', sessionId: 'session-1' });
    sessions.findActive.mockResolvedValue(buildSession());

    await expect(
      service.refreshTokens({ refreshToken: 'never-issued-token' }),
    ).rejects.toMatchObject({ code: ErrorCode.TOKEN_REVOKED });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1', 'token_theft');
  });
});
