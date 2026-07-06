import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { AdminLoginDto, ChangePasswordDto } from '../dto/admin-login.dto';
import { AdminCredentialsRepository } from '../repositories/admin-credentials.repository';
import { PasswordHistoryRepository } from '../repositories/password-history.repository';
import { SessionsRepository } from '../repositories/sessions.repository';
import { UsersRepository } from '../repositories/users.repository';
import { AuthJwtService } from './jwt.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { AuthResult, TokenPair } from '../types/auth.types';
import { hashPassword } from '../utils/password.utils';
import { createHash } from 'node:crypto';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const PASSWORD_HISTORY_DEPTH = 5;

/**
 * Admin login + password lifecycle.
 *
 * Lives alongside the OTP-based `AuthService` because they share the
 * same JWT, session, and user infrastructure. The only divergence is
 * the credential surface (email/password vs mobile/OTP).
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
    private readonly users: UsersRepository,
    private readonly credentials: AdminCredentialsRepository,
    private readonly history: PasswordHistoryRepository,
    private readonly sessions: SessionService,
    private readonly sessionsRepo: SessionsRepository,
    private readonly jwt: AuthJwtService,
    private readonly passwords: PasswordService,
  ) {}

  async login(dto: AdminLoginDto, ipAddress: string, userAgent: string): Promise<AuthResult> {
    const cred = await this.credentials.findByEmail(dto.email);
    // Constant-ish-time fall-through: still hash the supplied password
    // even when the email is unknown so an attacker can't time-detect
    // membership.
    if (!cred) {
      await this.passwords.verify(dto.password, '$2b$12$' + 'a'.repeat(53));
      throw new BusinessException(ErrorCode.INVALID_CREDENTIALS, 'Invalid credentials');
    }

    if (cred.lockedUntil && cred.lockedUntil.getTime() > Date.now()) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account is temporarily locked');
    }

    const ok = await this.passwords.verify(dto.password, cred.passwordHash);
    if (!ok) {
      const failures = await this.credentials.incrementFailedAttempts(cred.id);
      if (failures >= MAX_FAILED_ATTEMPTS) {
        const until = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
        await this.credentials.lockUntil(cred.id, until);
        await this.audit.logAction({
          action: 'UPDATE',
          resourceType: 'AdminCredentials',
          resourceId: cred.id,
          userId: cred.userId,
          tenantId: '',
          success: true,
          metadata: { reason: 'lockout', failures, until: until.toISOString() },
        });
      }
      throw new BusinessException(ErrorCode.INVALID_CREDENTIALS, 'Invalid credentials');
    }

    const user = await this.users.findById(cred.userId);
    if (!user || !user.isActive) {
      throw new BusinessException(ErrorCode.ACCOUNT_LOCKED, 'Account is deactivated');
    }
    if (user.role !== 'admin') {
      throw new BusinessException(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Admin role required');
    }
    if (!cred.emailVerifiedAt) {
      throw new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'Verify your email first');
    }

    await this.credentials.resetFailedAttempts(cred.id);

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
    await this.sessions.create(sessionId, user.id, this.hashToken(refreshToken), {
      ipAddress,
      userAgent,
      deviceId: dto.deviceId,
      platform: 'admin',
    });
    await this.users.update(user.id, { lastLoginAt: new Date(), isVerified: true });

    await this.audit.logAction({
      action: 'LOGIN',
      resourceType: 'AdminUser',
      resourceId: user.id,
      userId: user.id,
      tenantId: '',
      ipAddress,
      userAgent,
      success: true,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.jwt.accessTokenExpirySeconds,
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        storeIds: [],
        permissions: [],
        isVerified: user.isVerified,
        bypassOnboarding: false,
        createdAt: user.createdAt,
      },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    this.passwords.enforcePolicy(dto.newPassword, 'newPassword');

    const cred = await this.credentials.findByUserId(userId);
    if (!cred) {
      throw new BusinessException(ErrorCode.AUTHENTICATION_REQUIRED, 'No admin credentials');
    }
    const ok = await this.passwords.verify(dto.currentPassword, cred.passwordHash);
    if (!ok) {
      throw new BusinessException(ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
    }

    if (await this.isInHistory(userId, dto.newPassword)) {
      throw new BusinessException(
        ErrorCode.VALIDATION_ERROR,
        `Password recently used. Choose one not in your last ${PASSWORD_HISTORY_DEPTH}.`,
      );
    }

    const newHash = await hashPassword(dto.newPassword);
    await this.credentials.updatePasswordHash(cred.id, newHash);
    await this.history.create({ userId, passwordHash: cred.passwordHash });
    await this.history.deleteOlderThanRank(userId, PASSWORD_HISTORY_DEPTH);
    await this.sessionsRepo.revokeAllForUser(userId, 'admin');
  }

  /** Issue a token pair after a refreshing handler has validated the refresh token. */
  async refresh(userId: string, sessionId: string): Promise<TokenPair> {
    const user = await this.users.findById(userId);
    if (!user) throw new BusinessException(ErrorCode.USER_NOT_FOUND, 'User not found');
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
    return { accessToken, refreshToken, expiresIn: this.config.jwt.accessTokenExpirySeconds };
  }

  /** Public helper used by reset/invitation flows after they've already verified the token. */
  async setPassword(userId: string, plain: string): Promise<void> {
    this.passwords.enforcePolicy(plain);
    if (await this.isInHistory(userId, plain)) {
      throw new BusinessException(
        ErrorCode.VALIDATION_ERROR,
        `Password recently used. Choose one not in your last ${PASSWORD_HISTORY_DEPTH}.`,
      );
    }
    const cred = await this.credentials.findByUserId(userId);
    const newHash = await hashPassword(plain);
    if (cred) {
      await this.credentials.updatePasswordHash(cred.id, newHash);
      await this.history.create({ userId, passwordHash: cred.passwordHash });
    }
    await this.history.deleteOlderThanRank(userId, PASSWORD_HISTORY_DEPTH);
    await this.sessionsRepo.revokeAllForUser(userId, 'admin');
  }

  async createCredentials(userId: string, email: string, plain: string): Promise<void> {
    this.passwords.enforcePolicy(plain);
    const passwordHash = await hashPassword(plain);
    await this.credentials.create({ userId, email: email.toLowerCase(), passwordHash });
  }

  async markEmailVerified(userId: string): Promise<void> {
    const cred = await this.credentials.findByUserId(userId);
    if (cred) await this.credentials.markEmailVerified(cred.id);
  }

  private async isInHistory(userId: string, plain: string): Promise<boolean> {
    const recent = await this.history.findRecentForUser(userId, PASSWORD_HISTORY_DEPTH);
    for (const row of recent) {
      if (await this.passwords.verify(plain, row.passwordHash)) return true;
    }
    return false;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
