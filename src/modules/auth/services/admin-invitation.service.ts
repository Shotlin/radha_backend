import { Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { EmailService } from '@/integrations/email/email.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { AcceptInvitationDto, InviteAdminDto } from '../dto/admin-login.dto';
import { AdminCredentialsRepository } from '../repositories/admin-credentials.repository';
import { AdminInvitationsRepository } from '../repositories/admin-invitations.repository';
import { UsersRepository } from '../repositories/users.repository';
import { AdminAuthService } from './admin-auth.service';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/password.utils';

@Injectable()
export class AdminInvitationService {
  constructor(
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly audit: AuditLogService,
    private readonly users: UsersRepository,
    private readonly credentials: AdminCredentialsRepository,
    private readonly invitations: AdminInvitationsRepository,
    private readonly admin: AdminAuthService,
  ) {}

  async invite(invitedByUserId: string, dto: InviteAdminDto): Promise<{ id: string }> {
    const existing = await this.credentials.findByEmail(dto.email);
    if (existing) {
      throw new BusinessException(
        ErrorCode.USER_ALREADY_EXISTS,
        'An admin already exists with that email',
      );
    }
    const inviter = await this.users.findById(invitedByUserId);
    if (!inviter) throw new BusinessException(ErrorCode.USER_NOT_FOUND, 'Inviter not found');

    const { plaintext, hash } = generateOpaqueToken();
    const row = await this.invitations.create({
      invitedByUserId,
      email: dto.email,
      tokenHash: hash,
    });

    await this.email.sendTemplate('admin-invitation', dto.email, {
      inviterName: inviter.name || 'A RADHA admin',
      acceptLink: `https://radha.app/admin/accept?token=${plaintext}`,
      expiresIn: '7 days',
    });

    await this.audit.logAction({
      action: 'GRANT_ACCESS',
      resourceType: 'AdminInvitation',
      resourceId: row.id,
      userId: invitedByUserId,
      tenantId: '',
      success: true,
      metadata: { invitedEmail: dto.email },
    });

    return { id: row.id };
  }

  async accept(dto: AcceptInvitationDto): Promise<{ userId: string }> {
    const hash = hashOpaqueToken(dto.token);
    const invitation = await this.invitations.findActiveByHash(hash);
    if (!invitation) {
      throw new BusinessException(ErrorCode.TOKEN_INVALID, 'Invalid or used invitation');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(ErrorCode.TOKEN_EXPIRED, 'Invitation expired');
    }

    const user = await this.users.create({
      mobile: `admin:${invitation.email}`,
      role: 'admin',
      isVerified: false,
      isActive: true,
      name: dto.name,
      email: invitation.email,
    });
    await this.admin.createCredentials(user.id, invitation.email, dto.password);
    await this.admin.markEmailVerified(user.id); // Email proven by ownership of the invitation link
    await this.invitations.markAccepted(invitation.id);

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'AdminUser',
      resourceId: user.id,
      userId: user.id,
      tenantId: '',
      success: true,
    });

    return { userId: user.id };
  }

  async revoke(invitationId: string, byUserId: string): Promise<void> {
    await this.invitations.markRevoked(invitationId);
    await this.audit.logAction({
      action: 'REVOKE_ACCESS',
      resourceType: 'AdminInvitation',
      resourceId: invitationId,
      userId: byUserId,
      tenantId: '',
      success: true,
    });
  }
}
