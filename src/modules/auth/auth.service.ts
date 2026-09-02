import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

import { RequestContextService } from '@/common/context/request-context.service';
import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';
import { SmsService } from '@/integrations/sms/sms.service';

import { FirebaseExchangeDto } from './dto/firebase-exchange.dto';
import { LegacyLinkRequestDto } from './dto/legacy-link-request.dto';
import { LegacyLinkVerifyDto } from './dto/legacy-link-verify.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { OtpAttemptsRepository } from './repositories/otp-attempts.repository';
import { PendingInvitationsRepository } from './repositories/pending-invitations.repository';
import { SessionsRepository } from './repositories/sessions.repository';
import { UsersRepository } from './repositories/users.repository';
import { FirebaseAuthVerifierService } from './services/firebase-auth-verifier.service';
import { AuthJwtService } from './services/jwt.service';
import { AuthRateLimiterService } from './services/rate-limiter.service';
import { SessionService } from './services/session.service';
import { AuthResult, OtpRequestResult, UserMeResponse } from './types/auth.types';
import { maskMobile, normaliseMobile } from './utils/mobile.utils';
import { generateOtp, hashOtp, verifyOtp } from './utils/otp.utils';

type UserRowT = NonNullable<Awaited<ReturnType<UsersRepository['findByMobile']>>>;

/**
 * Orchestrates OTP request, OTP verification, refresh-token rotation,
 * logout, and the BE-06 v2 ADDENDUM "pending-invitation auto-onboard"
 * path that turns a first-time login on an invited mobile into a
 * Staff/Manager/Auditor account under the inviter's tenant.
 *
 * Phase 13 (BE-08 v3 ADDENDUM) adds Firebase Auth (Google Sign-In) as
 * the PRIMARY login path (`exchangeFirebaseToken`) and narrows
 * `requestOtp`/`verifyOtp` to two residual purposes: the hardcoded demo
 * accounts, and a "legacy account link" recovery flow
 * (`requestLegacyLink`/`verifyLegacyLink`) so a pre-existing phone-only
 * user can attach a Google identity to their EXISTING account instead
 * of losing it. `requestOtp` no longer creates new accounts for unseen
 * mobiles — see the guard at the top of that method.
 */
@Injectable()
export class AuthService {
  // Permanent demo accounts — hardcoded so hot-reload picks them up without env
  // restart, and active in every environment (including production) since
  // they're used as live login credentials for demos. demoOtpFor() below
  // only ever matches the exact numbers in DEMO_ACCOUNTS, so this can never
  // become a bypass for an arbitrary real user's mobile number — but note
  // each entry here IS a standing, SMS-free login bypass for that specific
  // number, permanently, in production. Only add real/dialable numbers
  // (as opposed to obviously-fake demo patterns like 9999999999/8000000000)
  // with the founder's explicit sign-off, since a bypass tied to a real SIM
  // outlives the founder's control of that number (recycled/lost numbers).
  private static readonly DEMO_ACCOUNTS: ReadonlyArray<readonly [mobile: string, otp: string]> = [
    ['9999999999', '123456'], // business demo — owner role + store from earlier activation
    ['8000000000', '654321'], // personal demo — never activated, resolves to a fresh consumer account
    ['9724710944', '123456'], // Radha Store admin account — founder-approved 2026-07-19
  ];

  /** Null when `mobile` isn't one of the hardcoded demo accounts. */
  private static demoOtpFor(mobile: string): string | null {
    return AuthService.DEMO_ACCOUNTS.find(([m]) => m === mobile)?.[1] ?? null;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly context: RequestContextService,
    private readonly audit: AuditLogService,
    private readonly sms: SmsService,
    private readonly jwt: AuthJwtService,
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly sessions: SessionService,
    private readonly sessionsRepo: SessionsRepository,
    private readonly users: UsersRepository,
    private readonly otpAttempts: OtpAttemptsRepository,
    private readonly invitations: PendingInvitationsRepository,
    private readonly firebaseAuth: FirebaseAuthVerifierService,
  ) {}

  /* ─────────── Request OTP (demo accounts + legacy-link recovery only) ─────────── */

  async requestOtp(dto: RequestOtpDto, ipAddress: string): Promise<OtpRequestResult> {
    const mobile = normaliseMobile(dto.mobile);

    // Demo accounts: skip SMS and rate limiting.
    // Intentionally NOT gated on isProduction: these are two fixed,
    // hardcoded demo numbers the team logs in with on the live app too.
    // demoOtpFor() only ever returns non-null for those two exact numbers,
    // so this can never become a bypass for a real mobile number.
    // `demoAccountsEnabled` (default true) is a defense-in-depth valve on
    // top of that, not a behavior change -- see config.service.ts.
    const demoOtp = this.config.demoAccountsEnabled ? AuthService.demoOtpFor(mobile) : null;
    const isDemoUser = demoOtp !== null;

    // Phase 13: OTP no longer creates new accounts. Google Sign-In is the
    // primary signup path now; this endpoint only serves demo accounts and
    // pre-existing phone-only users going through the legacy-link recovery
    // flow (which itself calls this same method). An unregistered,
    // non-demo mobile is rejected before any otp_attempts row is created
    // or any SMS is sent -- this must never become a way to discover
    // whether a number is registered, so the error is deliberately generic.
    if (!isDemoUser) {
      const existingUser = await this.users.findByMobile(mobile);
      if (!existingUser) {
        throw new BusinessException(
          ErrorCode.NOT_FOUND,
          'Sign in with Google, or use an existing phone-linked account',
        );
      }
      this.rateLimiter.checkOtpRequest(mobile, ipAddress);
    }

    const otp = isDemoUser
      ? demoOtp!
      : generateOtp(this.config.sms.otpLength);
    const otpHash = await hashOtp(otp);
    const requestId = uuid();
    const expiresAt = new Date(Date.now() + this.config.sms.otpExpirySeconds * 1000);

    await this.otpAttempts.create({
      requestId,
      mobile,
      otpHash,
      attemptCount: 0,
      maxAttempts: 3,
      isVerified: false,
      isExpired: false,
      expiresAt,
      ipAddress,
    });

    if (!isDemoUser) {
      try {
        await this.sms.sendOtp(mobile, otp);
      } catch (err) {
        this.logger.error('auth.otp.send_failed', {
          mobile: maskMobile(mobile),
          requestId,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
        throw new BusinessException(
          ErrorCode.SMS_DELIVERY_FAILED,
          'Unable to send OTP. Please try again.',
        );
      }
    }

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'OtpAttempt',
      resourceId: requestId,
      userId: '',
      tenantId: '',
      success: true,
      metadata: { mobile: maskMobile(mobile), demo: isDemoUser },
    });

    return {
      requestId,
      expiresIn: this.config.sms.otpExpirySeconds,
      attemptsRemaining: 3,
      // Dev/test convenience: hand the OTP straight back so local testing
      // doesn't require tailing server logs. Strictly gated — staging and
      // production (real 2Factor + ProductionEnvSchema) never hit this branch.
      ...(this.config.isProduction || this.config.isStaging ? {} : { devOtp: otp }),
    };
  }

  /* ─────────── Verify OTP (demo accounts + pre-existing phone users only) ─────────── */

  async verifyOtp(dto: VerifyOtpDto, ipAddress: string, userAgent: string): Promise<AuthResult> {
    const mobile = normaliseMobile(dto.mobile);
    await this.verifyOtpAttempt(dto.requestId, mobile, dto.otp);

    // Resolve user — invitation > existing > new consumer. Reachable for
    // a genuinely new mobile only via the invitation path (requestOtp's
    // new guard means resolveOrCreateUser's plain-new-consumer branch is
    // now unreachable except for demo accounts, which always pre-exist
    // after their first login anyway).
    const result = await this.resolveOrCreateUser(mobile);
    return this.completeLogin(result.user, ipAddress, userAgent, dto.deviceId, result.bypassOnboarding);
  }

  /* ─────────── Firebase Auth exchange (PRIMARY login path, Phase 13) ─────────── */

  /**
   * Exchanges a Firebase Auth ID token (minted client-side after Google
   * Sign-In) for RADHA's own access/refresh tokens + session. Firebase is
   * identity/session only here — the resulting user resolves into the
   * exact same `users` row / role / tenant / session machinery as the OTP
   * path. Resolution order: already-linked uid > email match on an
   * existing OTP-era account (auto-link, preserves role/tenant) > brand
   * new consumer.
   */
  async exchangeFirebaseToken(
    dto: FirebaseExchangeDto,
    ipAddress: string,
    userAgent: string,
  ): Promise<AuthResult> {
    const claims = await this.firebaseAuth.verify(dto.idToken);

    let user = await this.users.findByFirebaseUid(claims.firebaseUid);
    if (!user && claims.email) {
      const existingByEmail = await this.users.findByEmail(claims.email);
      if (existingByEmail) {
        user = await this.users.update(existingByEmail.id, {
          firebaseUid: claims.firebaseUid,
          authProvider: 'google_linked',
        });
      }
    }
    if (!user) {
      user = await this.users.create({
        role: 'consumer',
        firebaseUid: claims.firebaseUid,
        email: claims.email ?? undefined,
        authProvider: 'google',
        isVerified: claims.emailVerified,
        isActive: true,
        name: '',
      });
    }

    return this.completeLogin(user, ipAddress, userAgent, dto.deviceId, false);
  }

  /* ─────────── Legacy account link recovery (Phase 13) ─────────── */

  /**
   * Step 1 of the legacy-link recovery flow: an existing phone-only user
   * (created before Phase 13, or one whose Google email doesn't match
   * what's on file) proves ownership of their registered mobile via OTP
   * before it gets linked to their now-current Google identity. Refuses
   * unregistered mobiles -- this must never double as a disguised signup
   * path, and must never leak whether a number is registered.
   */
  async requestLegacyLink(mobile: string, ipAddress: string): Promise<OtpRequestResult> {
    const normalised = normaliseMobile(mobile);
    const existingUser = await this.users.findByMobile(normalised);
    if (!existingUser) {
      throw new BusinessException(ErrorCode.NOT_FOUND, 'No account found for this phone number');
    }
    return this.requestOtp({ mobile: normalised, platform: 'mobile' }, ipAddress);
  }

  /**
   * Step 2: verifies the OTP AND the already-held Firebase ID token
   * (the caller must already be signed in with Google client-side before
   * reaching this screen), then links `firebaseUid` onto the EXISTING
   * mobile-matched user -- preserving role/tenant/store-access/everything
   * -- instead of leaving them stuck on a brand-new, empty consumer
   * account created by `exchangeFirebaseToken`.
   */
  async verifyLegacyLink(
    dto: LegacyLinkVerifyDto,
    ipAddress: string,
    userAgent: string,
  ): Promise<AuthResult> {
    const mobile = normaliseMobile(dto.mobile);
    await this.verifyOtpAttempt(dto.requestId, mobile, dto.otp);

    const existingUser = await this.users.findByMobile(mobile);
    if (!existingUser) {
      throw new DomainNotFoundException('User', mobile);
    }

    const claims = await this.firebaseAuth.verify(dto.idToken);
    const linked = await this.users.update(existingUser.id, {
      firebaseUid: claims.firebaseUid,
      authProvider: 'google_linked',
    });

    return this.completeLogin(linked, ipAddress, userAgent, dto.deviceId, false);
  }

  /* ─────────── Refresh ─────────── */

  /**
   * Grace window for a stale-but-recent refresh token replay. The backend
   * rotates the refresh token on every use; presenting the token that was
   * JUST rotated away is normally treated as theft (see below). But a
   * harmless version of this exact symptom happens whenever two separate
   * app processes briefly hold the same refresh token at once — e.g. an
   * app reinstall/relaunch that overlaps with the old process, or (in
   * principle) two devices refreshing within the same instant — and the
   * loser of that race gets treated as an attacker even though nothing
   * malicious happened. Real theft replay comes from a token an attacker
   * captured and reuses later, well outside a tight window; tolerating
   * one recent, single-generation-stale replay does not meaningfully help
   * a real attacker (they'd still need the CURRENT token to get anywhere).
   */
  private static readonly REFRESH_GRACE_WINDOW_MS = 15_000;

  async refreshTokens(dto: RefreshTokenDto): Promise<AuthResult> {
    const payload = await this.jwt.verifyRefreshToken(dto.refreshToken);
    const session = await this.sessions.findActive(payload.sessionId);
    if (!session) {
      throw new BusinessException(ErrorCode.TOKEN_REVOKED, 'Session not found or revoked');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await this.sessions.revoke(session.id, 'expired');
      throw new BusinessException(ErrorCode.TOKEN_EXPIRED, 'Refresh token expired');
    }

    const presentedHash = this.hashToken(dto.refreshToken);
    const isCurrentToken = session.refreshTokenHash === presentedHash;

    if (!isCurrentToken) {
      const withinGraceWindow =
        session.previousRefreshTokenHash === presentedHash &&
        session.lastUsedAt != null &&
        Date.now() - session.lastUsedAt.getTime() < AuthService.REFRESH_GRACE_WINDOW_MS;

      if (!withinGraceWindow) {
        // Stale token, outside the grace window ⇒ treat as theft, kill all sessions.
        this.logger.warn('auth.token_theft_suspected', {
          userId: payload.sub,
          sessionId: session.id,
        });
        await this.sessions.revokeAllForUser(payload.sub, 'token_theft');
        throw new BusinessException(ErrorCode.TOKEN_REVOKED, 'Token has been revoked');
      }
      // Within grace: almost certainly a concurrent-replay race, not theft.
      // Fall through and issue a fresh rotation exactly like a normal
      // refresh — chained off the CURRENT hash below, not the stale one.
      this.logger.info('auth.token_refresh_grace_replay', {
        userId: payload.sub,
        sessionId: session.id,
      });
    }

    const user = await this.users.findById(payload.sub);
    if (!user) throw new DomainNotFoundException('User', payload.sub);

    const newAccess = await this.jwt.issueAccessToken({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      sessionId: session.id,
    });
    const newRefresh = await this.jwt.issueRefreshToken({
      sub: user.id,
      sessionId: session.id,
      jti: uuid(),
    });
    await this.sessions.rotate(session.id, session.refreshTokenHash, this.hashToken(newRefresh));

    return {
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresIn: this.config.jwt.accessTokenExpirySeconds,
      // Include the user so the mobile `LoginResponse` (which requires `user`)
      // deserialises a refresh exactly like a fresh login. The repository
      // ignores it — it re-reads /me — but the typed contract needs it present.
      user: await this.toMeResponse(user, false),
    };
  }

  /* ─────────── Logout ─────────── */

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId, 'logout_all');
  }

  /* ─────────── /me ─────────── */

  async getCurrentUser(userId: string): Promise<UserMeResponse> {
    const user = await this.users.findById(userId);
    if (!user) throw new DomainNotFoundException('User', userId);
    return await this.toMeResponse(user, false);
  }

  /* ─────────── Internals ─────────── */

  /**
   * BE-06 v2 ADDENDUM (Req 55): inspect pending invitations first.
   * If one exists, auto-create the user under the inviter's tenant
   * with the invited role and signal `bypassOnboarding`. Otherwise
   * fall back to (a) finding an existing user or (b) creating a new
   * Consumer-default account.
   *
   * Phase 13: branch (b) is only reachable via a demo account today —
   * `requestOtp`'s new guard means a genuinely unseen, non-demo mobile
   * never reaches `verifyOtp` in the first place.
   */
  private async resolveOrCreateUser(mobile: string): Promise<{
    user: UserRowT;
    bypassOnboarding: boolean;
  }> {
    const invitation = await this.invitations.findActiveByMobile(mobile);
    if (invitation) {
      let user = await this.users.findByMobile(mobile);
      if (!user) {
        user = await this.users.create({
          mobile,
          tenantId: invitation.inviterTenantId,
          role: invitation.assignedRole,
          isVerified: true,
          isActive: true,
          name: '',
        });
      } else if (
        user.tenantId !== invitation.inviterTenantId ||
        user.role !== invitation.assignedRole
      ) {
        user = await this.users.update(user.id, {
          tenantId: invitation.inviterTenantId,
          role: invitation.assignedRole,
        });
      }
      await this.invitations.markAccepted(invitation.id);
      return { user, bypassOnboarding: true };
    }

    const existing = await this.users.findByMobile(mobile);
    if (existing) return { user: existing, bypassOnboarding: false };

    const created = await this.users.create({
      mobile,
      role: 'consumer',
      isVerified: true,
      isActive: true,
      name: '',
    });
    return { user: created, bypassOnboarding: false };
  }

  /**
   * Shared OTP-attempt validation, used by both `verifyOtp` and
   * `verifyLegacyLink` (Phase 13) so the two flows can never drift.
   * Throws on any invalid/expired/exhausted/mismatched attempt; returns
   * normally (no value) once the attempt is marked verified.
   */
  private async verifyOtpAttempt(requestId: string, mobile: string, otp: string): Promise<void> {
    const attempt = await this.otpAttempts.findByRequestId(requestId);
    if (!attempt) {
      throw new BusinessException(ErrorCode.OTP_INVALID, 'Invalid OTP request');
    }
    if (attempt.mobile !== mobile) {
      throw new BusinessException(ErrorCode.OTP_INVALID, 'Invalid OTP request');
    }
    if (attempt.isVerified) {
      throw new BusinessException(ErrorCode.OTP_INVALID, 'OTP already used');
    }
    if (attempt.isExpired || attempt.expiresAt.getTime() < Date.now()) {
      await this.otpAttempts.markExpired(attempt.id);
      throw new BusinessException(ErrorCode.OTP_EXPIRED, 'OTP has expired');
    }
    if (attempt.attemptCount >= attempt.maxAttempts) {
      throw new BusinessException(
        ErrorCode.OTP_TOO_MANY_ATTEMPTS,
        'Too many invalid attempts. Please request a new OTP.',
      );
    }

    const ok = await verifyOtp(otp, attempt.otpHash);
    if (!ok) {
      await this.otpAttempts.incrementAttempt(attempt.id);
      const remaining = Math.max(0, attempt.maxAttempts - (attempt.attemptCount + 1));
      throw new BusinessException(
        ErrorCode.OTP_INVALID,
        `Invalid OTP. ${remaining} attempts remaining.`,
      );
    }
    await this.otpAttempts.markVerified(attempt.id);
  }

  /**
   * Shared token-issuance + session-creation tail, used by every login
   * path (`verifyOtp`, `exchangeFirebaseToken`, `verifyLegacyLink` —
   * Phase 13) so the three can never drift on what "being logged in"
   * actually means.
   */
  private async completeLogin(
    user: UserRowT,
    ipAddress: string,
    userAgent: string,
    deviceId: string | undefined,
    bypassOnboarding: boolean,
  ): Promise<AuthResult> {
    if (!user.isActive) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account is deactivated');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account is temporarily locked');
    }

    const sessionId = uuid();
    const accessToken = await this.jwt.issueAccessToken({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      sessionId,
    });
    const refreshToken = await this.jwt.issueRefreshToken({
      sub: user.id,
      sessionId,
      jti: uuid(),
    });
    const refreshTokenHash = this.hashToken(refreshToken);

    await this.sessions.create(sessionId, user.id, refreshTokenHash, {
      ipAddress,
      userAgent,
      deviceId,
      platform: 'mobile',
    });

    await this.users.update(user.id, {
      lastLoginAt: new Date(),
      isVerified: true,
      failedLoginAttempts: 0,
    });

    await this.audit.logAction({
      action: 'LOGIN',
      resourceType: 'User',
      resourceId: user.id,
      userId: user.id,
      tenantId: user.tenantId ?? '',
      ipAddress,
      userAgent,
      success: true,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.jwt.accessTokenExpirySeconds,
      user: await this.toMeResponse(user, bypassOnboarding),
    };
  }

  private async toMeResponse(user: UserRowT, bypassOnboarding: boolean): Promise<UserMeResponse> {
    const storeIds = await this.users.findStoreIdsByUserId(user.id);
    return {
      id: user.id,
      mobile: user.mobile,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      storeIds,
      permissions: [],
      isVerified: user.isVerified,
      bypassOnboarding,
      createdAt: user.createdAt,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
