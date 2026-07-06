import { Body, Controller, HttpCode, Post, Req, Version } from '@nestjs/common';
import type { Request } from 'express';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';

import {
  AcceptInvitationDto,
  AcceptInvitationSchema,
  AdminLoginDto,
  AdminLoginSchema,
  CompletePasswordResetDto,
  CompletePasswordResetSchema,
  RequestPasswordResetDto,
  RequestPasswordResetSchema,
  VerifyEmailDto,
  VerifyEmailSchema,
} from './dto/admin-login.dto';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminInvitationService } from './services/admin-invitation.service';
import { EmailVerificationService } from './services/email-verification.service';
import { PasswordResetService } from './services/password-reset.service';

/**
 * Admin auth surface.
 *
 *   POST /api/v1/auth/admin/login
 *   POST /api/v1/auth/password/reset/request
 *   POST /api/v1/auth/password/reset/complete
 *   POST /api/v1/auth/email/verify
 *   POST /api/v1/auth/admin/invitations/accept
 *
 * Mutating admin endpoints (issue invitation, change password, etc.)
 * land in BE-08 once the JWT guards exist.
 */
@Controller('auth')
export class AdminAuthController {
  constructor(
    private readonly admin: AdminAuthService,
    private readonly reset: PasswordResetService,
    private readonly verification: EmailVerificationService,
    private readonly invitations: AdminInvitationService,
  ) {}

  @Post('admin/login')
  @Version('1')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(AdminLoginSchema)) dto: AdminLoginDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const userAgent = req.headers['user-agent'] ?? '';
    return this.admin.login(dto, ip, userAgent);
  }

  @Post('password/reset/request')
  @Version('1')
  @HttpCode(200)
  async requestReset(
    @Body(new ZodValidationPipe(RequestPasswordResetSchema)) dto: RequestPasswordResetDto,
    @Req() req: Request,
  ): Promise<{ status: 'queued' }> {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    await this.reset.requestReset(dto.email, ip);
    return { status: 'queued' };
  }

  @Post('password/reset/complete')
  @Version('1')
  @HttpCode(200)
  async completeReset(
    @Body(new ZodValidationPipe(CompletePasswordResetSchema)) dto: CompletePasswordResetDto,
    @Req() req: Request,
  ): Promise<{ status: 'ok' }> {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    await this.reset.completeReset(dto.token, dto.newPassword, ip);
    return { status: 'ok' };
  }

  @Post('email/verify')
  @Version('1')
  @HttpCode(200)
  async verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailSchema)) dto: VerifyEmailDto,
  ): Promise<{ status: 'verified' }> {
    await this.verification.verify(dto.token);
    return { status: 'verified' };
  }

  @Post('admin/invitations/accept')
  @Version('1')
  @HttpCode(200)
  acceptInvitation(@Body(new ZodValidationPipe(AcceptInvitationSchema)) dto: AcceptInvitationDto) {
    return this.invitations.accept(dto);
  }
}
