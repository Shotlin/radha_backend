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

import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { OtpAttemptsRepository } from './repositories/otp-attempts.repository';
import { PendingInvitationsRepository } from './repositories/pending-invitations.repository';
import { SessionsRepository } from './repositories/sessions.repository';
import { UsersRepository } from './repositories/users.repository';
import { AuthJwtService } from './services/jwt.service';
import { AuthRateLimiterService } from './services/rate-limiter.service';
import { SessionService } from './services/session.service';
import { AuthResult, OtpRequestResult, UserMeResponse } from './types/auth.types';
import { maskMobile, normaliseMobile } from './utils/mobile.utils';
import { generateOtp, hashOtp, verifyOtp } from './utils/otp.utils';

/**
 * Orchestrates OTP request, OTP verification, refresh-token rotation,
 * logout, and the BE-06 v2 ADDENDUM "pending-invitation auto-onboard"
 * path that turns a first-time login on an invited mobile into a
 * Staff/Manager/Auditor account under the inviter's tenant.
 */
@Injectable()
export class AuthService {
  // Permanent demo accounts — hardcoded so hot-reload picks them up without env
  // restart, and active in every environment (including production) since
  // they're used as live login credentials for demos. Safe by construction:
  // demoOtpFor() below only ever matches these two exact numbers, so this can
  // never become a bypass for a real user's mobile number. Two numbers so
  // client demos can show both surfaces: the business number already carries
  // an owner role + store from earlier activation;
  // the personal number is intentionally never activated, so it resolves to
  // a fresh `role: 'consumer'` account (see resolveOrCreateUser) — business
  // vs personal mode then falls out of the existing role-based routing with
  // no extra logic needed here.
  private static readonly DEMO_MOBILE = '9999999999';
  private static readonly DEMO_OTP = '123456';
  private static readonly DEMO_MOBILE_PERSONAL = '8000000000';
  private static readonly DEMO_OTP_PERSONAL = '654321';

  /** Null when `mobile` isn't one of the hardcoded demo accounts. */
  private static demoOtpFor(mobile: string): string | null {
    if (mobile === AuthService.DEMO_MOBILE) return AuthService.DEMO_OTP;
    if (mobile === AuthService.DEMO_MOBILE_PERSONAL) return AuthService.DEMO_OTP_PERSONAL;
    return null;
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
  ) {}

  /* ─────────── Request OTP ─────────── */

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

    if (!isDemoUser) this.rateLimiter.checkOtpRequest(mobile, ipAddress);

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

  /* ─────────── Verify OTP ─────────── */

  async verifyOtp(dto: VerifyOtpDto, ipAddress: string, userAgent: string): Promise<AuthResult> {
    const mobile = normaliseMobile(dto.mobile);

    const attempt = await this.otpAttempts.findByRequestId(dto.requestId);
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

    const ok = await verifyOtp(dto.otp, attempt.otpHash);
    if (!ok) {
      await this.otpAttempts.incrementAttempt(attempt.id);
      const remaining = Math.max(0, attempt.maxAttempts - (attempt.attemptCount + 1));
      throw new BusinessException(
        ErrorCode.OTP_INVALID,
        `Invalid OTP. ${remaining} attempts remaining.`,
      );
    }
    await this.otpAttempts.markVerified(attempt.id);

    // Resolve user — invitation > existing > new consumer.
    const result = await this.resolveOrCreateUser(mobile);
    const user = result.user;

    if (!user.isActive) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account is deactivated');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account is temporarily locked');
    }

    // Mint tokens + session.
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
      deviceId: dto.deviceId,
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
      user: await this.toMeResponse(user, result.bypassOnboarding),
    };
  }

  /* ─────────── Refresh ─────────── */

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
    if (session.refreshTokenHash !== presentedHash) {
      // Token rotation mismatch ⇒ treat as theft, kill all sessions.
      this.logger.warn('auth.token_theft_suspected', {
        userId: payload.sub,
        sessionId: session.id,
      });
      await this.sessions.revokeAllForUser(payload.sub, 'token_theft');
      throw new BusinessException(ErrorCode.TOKEN_REVOKED, 'Token has been revoked');
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
    await this.sessions.rotate(session.id, this.hashToken(newRefresh));

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
   */
  private async resolveOrCreateUser(mobile: string): Promise<{
    user: Awaited<ReturnType<UsersRepository['findByMobile']>> & object;
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

  private async toMeResponse(
    user: NonNullable<Awaited<ReturnType<UsersRepository['findByMobile']>>>,
    bypassOnboarding: boolean,
  ): Promise<UserMeResponse> {
    const storeIds = await this.users.findStoreIdsByUserId(user.id);
    return {
      id: user.id,
      mobile: user.mobile,
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
