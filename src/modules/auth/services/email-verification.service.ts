import { Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { EmailService } from '@/integrations/email/email.service';

import { AdminCredentialsRepository } from '../repositories/admin-credentials.repository';
import { EmailVerificationRepository } from '../repositories/email-verification.repository';
import { UsersRepository } from '../repositories/users.repository';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/password.utils';
import { AdminAuthService } from './admin-auth.service';

const VERIFICATION_TTL_SEC = 24 * 60 * 60;

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly email: EmailService,
    private readonly users: UsersRepository,
    private readonly credentials: AdminCredentialsRepository,
    private readonly tokens: EmailVerificationRepository,
    private readonly admin: AdminAuthService,
  ) {}

  async sendVerification(userId: string): Promise<void> {
    const cred = await this.credentials.findByUserId(userId);
    if (!cred) return;
    if (cred.emailVerifiedAt) return;

    const user = await this.users.findById(userId);
    if (!user) return;

    const { plaintext, hash } = generateOpaqueToken();
    await this.tokens.create({
      userId,
      email: cred.email,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_SEC * 1000),
    });

    await this.email.sendTemplate('email-verification', cred.email, {
      name: user.name || cred.email,
      verifyLink: `https://radha.app/admin/verify-email?token=${plaintext}`,
    });
  }

  async verify(plainToken: string): Promise<void> {
    const hash = hashOpaqueToken(plainToken);
    const row = await this.tokens.findActiveByHash(hash);
    if (!row) throw new BusinessException(ErrorCode.TOKEN_INVALID, 'Invalid or used token');
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(ErrorCode.TOKEN_EXPIRED, 'Verification token expired');
    }
    await this.admin.markEmailVerified(row.userId);
    await this.tokens.markConsumed(row.id);
  }
}
