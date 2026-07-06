import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { OnboardingController } from './controllers/onboarding.controller';
import { OnboardingService } from './services/onboarding.service';

/**
 * BE-34 — Onboarding self-selection module.
 *
 * Provides the POST /api/v1/onboarding/segment endpoint that persists
 * the user's segment choice and returns a routing instruction.
 *
 * Depends on AuthModule for:
 *   - JwtAuthGuard (route protection)
 *   - UsersRepository (DB access to users table)
 */
@Module({
  imports: [AuthModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
