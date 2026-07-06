import { Controller, Get, Param, Query, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';

import {
  IngredientExplanationDto,
  IngredientExplanationQueryDto,
  IngredientExplanationQuerySchema,
} from '../dto/ingredient-explanation.dto';
import { IngredientExplainerService } from '../services/ingredient-explainer.service';

/**
 * BE-40 — Ingredient explainer REST controller.
 *
 * Endpoint:
 *   GET /api/v1/ingredients/:slug/explanation?locale=en|hi|ta|te|bn|mr
 *
 * Transport-only — all business logic lives in
 * `IngredientExplainerService`. The endpoint is intentionally
 * unauthenticated at the controller level: explanations are universal
 * and tenant-agnostic. Rate-limiting / auth (where required) is
 * applied globally by the API gateway / app-level guards.
 */
@Controller('ingredients')
export class IngredientExplainerController {
  constructor(private readonly service: IngredientExplainerService) {}

  @Get(':slug/explanation')
  @Version('1')
  async getExplanation(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(IngredientExplanationQuerySchema))
    query: IngredientExplanationQueryDto,
  ): Promise<IngredientExplanationDto> {
    return this.service.getExplanation(slug, query.locale);
  }
}
