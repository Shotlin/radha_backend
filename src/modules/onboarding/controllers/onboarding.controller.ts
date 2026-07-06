import { Body, Controller, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import type { OnboardingRoutingDto } from '../dto/onboarding-routing.dto';
import { SelectSegmentDto, SelectSegmentSchema } from '../dto/select-segment.dto';
import { OnboardingService } from '../services/onboarding.service';

/**
 * BE-34 — Onboarding self-selection controller.
 *
 * Single endpoint for the 2x3 tap-card onboarding screen (Req 26).
 * Transport only — all business logic lives in OnboardingService.
 */
@Controller('onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('segment')
  @Version('1')
  @HttpCode(200)
  async selectSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(SelectSegmentSchema)) dto: SelectSegmentDto,
  ): Promise<OnboardingRoutingDto> {
    return this.onboarding.selectSegment(user.id, dto.segment);
  }
}
