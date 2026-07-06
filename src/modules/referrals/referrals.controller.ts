import { Body, Controller, Get, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import { ApplyReferralDto, ApplyReferralSchema } from './dto/apply-referral.dto';
import type { ReferralSummaryDto } from './dto/referral-summary.dto';
import { ReferralsService } from './referrals.service';

/**
 * BE-43 — Referral REST surface.
 *
 *   GET  /api/v1/referrals/me      Bearer  Caller's code + summary
 *   POST /api/v1/referrals/apply   Bearer  Apply a referral code
 *                                          (called during signup)
 *
 * Transport only — all logic lives in `ReferralsService`. Both routes
 * sit behind `JwtAuthGuard` because they're called from the mobile
 * app after the OTP exchange has issued a session token. The apply
 * endpoint is intentionally idempotent: repeat calls for the same
 * `(user, code)` pair return the same shape with `applied: false` on
 * the second invocation.
 */
@Controller('referrals')
@UseGuards(JwtAuthGuard)
export class ReferralsController {
  constructor(private readonly service: ReferralsService) {}

  @Get('me')
  @Version('1')
  getMine(@CurrentUser('id') userId: string): Promise<ReferralSummaryDto> {
    return this.service.getMyReferralSummary(userId);
  }

  @Post('apply')
  @Version('1')
  @HttpCode(200)
  apply(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(ApplyReferralSchema)) dto: ApplyReferralDto,
  ): Promise<{ applied: boolean; reason?: string }> {
    return this.service.applyReferralOnSignup(userId, dto.code);
  }
}
