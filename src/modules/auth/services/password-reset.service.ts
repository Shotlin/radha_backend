import { Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';
import { EmailService } from '@/integrations/email/email.service';

import { AdminCredentialsRepository } from '../repositories/admin-credentials.repository';
import { PasswordResetRepository } from '../repositories/password-reset.repository';
import { UsersRepository } from '../repositories/users.repository';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/password.utils';
import { AdminAuthService } from './admin-auth.service';

const RESET_TOKEN_TTL_SEC = 60 * 60;

/**
 * Password reset orchestration.
 *
 * The "request" path is intentionally always-200 (no email enumeration).
 * The "complete" path is single-use and consumes the token after a
 * successful password change.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
    private readonly email: EmailService,
    private readonly users: UsersRepository,
    private readonly credentials: AdminCredentialsRepository,
    private readonly tokens: PasswordResetRepository,
    private readonly admin: AdminAuthService,
  ) {}

  async requestReset(email: string, ipAddress: string): Promise<void> {
    const cred = await this.credentials.findByEmail(email);
    if (!cred) {
      // Same shape, same rough timing.
      this.logger.info('password.reset.request.unknown_email', {});
      return;
    }
    const user = await this.users.findById(cred.userId);
    if (!user) return;

    const { plaintext, hash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_SEC * 1000);
    await this.tokens.create({
      userId: cred.userId,
      tokenHash: hash,
      expiresAt,
      requestedFromIp: ipAddress,
    });

    await this.email.sendTemplate('password-reset', cred.email, {
      name: user.name || cred.email,
      resetLink: `https://radha.app/admin/reset?token=${plaintext}`,
      expiresIn: '1 hour',
    });

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'PasswordResetToken',
      resourceId: cred.userId,
      userId: cred.userId,
      tenantId: '',
      ipAddress,
      success: true,
    });
  }

  async completeReset(plainToken: string, newPassword: string, ipAddress: string): Promise<void> {
    const hash = hashOpaqueToken(plainToken);
    const row = await this.tokens.findActiveByHash(hash);
    if (!row) {
      throw new BusinessException(ErrorCode.TOKEN_INVALID, 'Invalid or used reset token');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(ErrorCode.TOKEN_EXPIRED, 'Reset token expired');
    }

    await this.admin.setPassword(row.userId, newPassword);
    await this.tokens.markConsumed(row.id);
    await this.tokens.revokeAllForUser(row.userId);

    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'AdminCredentials',
      resourceId: row.userId,
      userId: row.userId,
      tenantId: '',
      ipAddress,
      success: true,
      metadata: { reason: 'password_reset' },
    });
  }
}
