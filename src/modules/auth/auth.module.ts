import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ConfigService } from '@/config/config.service';

import { AdminAuthController } from './admin-auth.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from './guards/optional-jwt.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RolesGuard } from './guards/roles.guard';
import { TenantScopeGuard } from './guards/tenant-scope.guard';
import { AdminCredentialsRepository } from './repositories/admin-credentials.repository';
import { AdminInvitationsRepository } from './repositories/admin-invitations.repository';
import { EmailVerificationRepository } from './repositories/email-verification.repository';
import { OtpAttemptsRepository } from './repositories/otp-attempts.repository';
import { PasswordHistoryRepository } from './repositories/password-history.repository';
import { PasswordResetRepository } from './repositories/password-reset.repository';
import { PendingInvitationsRepository } from './repositories/pending-invitations.repository';
import { SessionsRepository } from './repositories/sessions.repository';
import { UsersRepository } from './repositories/users.repository';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminInvitationService } from './services/admin-invitation.service';
import { EmailVerificationService } from './services/email-verification.service';
import { AuthJwtService } from './services/jwt.service';
import { PasswordService } from './services/password.service';
import { PasswordResetService } from './services/password-reset.service';
import { PermissionsService } from './services/permissions.service';
import { AuthRateLimiterService } from './services/rate-limiter.service';
import { SessionService } from './services/session.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.jwt.accessTokenSecret }),
    }),
  ],
  controllers: [AuthController, AdminAuthController],
  providers: [
    AuthService,
    AdminAuthService,
    PasswordService,
    PasswordResetService,
    EmailVerificationService,
    AdminInvitationService,
    AuthJwtService,
    AuthRateLimiterService,
    SessionService,
    UsersRepository,
    SessionsRepository,
    OtpAttemptsRepository,
    PendingInvitationsRepository,
    AdminCredentialsRepository,
    PasswordHistoryRepository,
    PasswordResetRepository,
    EmailVerificationRepository,
    AdminInvitationsRepository,
    PermissionsService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
    PermissionsGuard,
    TenantScopeGuard,
  ],
  exports: [
    AuthService,
    AdminAuthService,
    AuthJwtService,
    PermissionsService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
    PermissionsGuard,
    TenantScopeGuard,
    UsersRepository,
    SessionsRepository,
    AdminCredentialsRepository,
    PendingInvitationsRepository,
  ],
})
export class AuthModule {}
