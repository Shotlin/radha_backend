import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { ReferralsController } from './referrals.controller';
import { ReferralsRepository } from './referrals.repository';
import { ReferralsService } from './referrals.service';

/**
 * BE-43 — Referral Program module.
 *
 * Imports:
 *   - `AuthModule`         → `JwtAuthGuard` for the controller and
 *                            `UsersRepository` for any future
 *                            cross-module lookup (this module owns
 *                            its own thin `ReferralsRepository`).
 *   - `ObservabilityModule`→ `AuditLogService`. It's `@Global()` so
 *                            no explicit import is required here.
 *
 * Exports `ReferralsService` so the BE-08 signup flow can call
 * `applyReferralOnSignup(newUserId, code)` after OTP verification
 * lands a fresh user row.
 */
@Module({
  imports: [AuthModule],
  controllers: [ReferralsController],
  providers: [ReferralsRepository, ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
