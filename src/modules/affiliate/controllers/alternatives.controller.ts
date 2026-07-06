import { Controller, Get, Param, Query, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import {
  AlternativesQuerySchema,
  type AlternativesQueryDto,
  type HealthierAlternativeDto,
} from '../dto/healthier-alternative.dto';
import { HealthyAlternativesService } from '../services/healthy-alternatives.service';

/**
 * BE-41 — Healthy Alternatives REST surface.
 *
 *   GET /api/v1/products/:ean/alternatives  Bearer
 *
 * Returns up to 3 healthier products in the same category as the
 * source EAN, each carrying a partner-rendered affiliate link.
 *
 * Transport only — recommendation logic lives in
 * `HealthyAlternativesService`. Authentication is required because
 * the engine is a Premium consumer feature gated by the per-tier
 * `affiliateAlternatives` entitlement (BE-08 v2). The service
 * already returns an empty list when no source product matches, no
 * candidates pass the score-delta gate, or no active partner is
 * configured — so a 200 with `[]` is a normal response.
 */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class AlternativesController {
  constructor(private readonly alternatives: HealthyAlternativesService) {}

  @Get(':ean/alternatives')
  @Version('1')
  async list(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future entitlement gating
    @CurrentUser() _user: AuthenticatedUser,
    @Param('ean') ean: string,
    @Query(new ZodValidationPipe(AlternativesQuerySchema)) query: AlternativesQueryDto,
  ): Promise<HealthierAlternativeDto[]> {
    return this.alternatives.recommend(ean, { partnerName: query.partner });
  }
}
