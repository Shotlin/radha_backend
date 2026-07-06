import { Controller, Get, UseGuards, Version } from '@nestjs/common';

import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import type { WeeklyDigestResponseDto } from './dto/weekly-digest.dto';
import { WeeklyDigestService } from './services/weekly-digest.service';

/**
 * BE-54 — Weekly Digest read surface.
 *
 *   GET /api/v1/weekly-digest   Bearer   The caller's latest weekly
 *                                        health summary ("Your week
 *                                        with RADHA").
 *
 * Transport only — all logic lives in `WeeklyDigestService`. The cron
 * produces digests every Sunday; this endpoint returns the freshest
 * one and lazily materialises the previous week if none exists yet, so
 * the Mobile_App screen is never blank for an active account.
 *
 * Consumer-facing: the mobile app only links here from the personal
 * (consumer) profile, never from the business module.
 */
@Controller('weekly-digest')
@UseGuards(JwtAuthGuard)
export class WeeklyDigestController {
  constructor(private readonly service: WeeklyDigestService) {}

  @Get()
  @Version('1')
  getMine(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ): Promise<WeeklyDigestResponseDto> {
    return this.service.getDigestForUser(userId, tenantId);
  }
}
