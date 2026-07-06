import { Module } from '@nestjs/common';

import { ObservabilityModule } from '@/observability/observability.module';

import { IngredientExplainerController } from './controllers/ingredient-explainer.controller';
import { IngredientExplanationRepository } from './repositories/ingredient-explanation.repository';
import { IngredientExplainerService } from './services/ingredient-explainer.service';
import { LlmExplainerService } from './services/llm-explainer.service';

/**
 * BE-40 — AI Ingredient Explainer module.
 *
 * Surfaces:
 *   - HTTP `IngredientExplainerController`
 *     (GET /api/v1/ingredients/:slug/explanation?locale=...)
 *
 * Module wiring:
 *   - `ObservabilityModule` provides `IErrorTrackingService` for
 *     graceful exception capture on LLM timeout / failure.
 *
 * The LLM provider (`LlmExplainerService`) is registered as an
 * injectable so tests can override it with a mock and a future
 * BE-22 v2 integration can swap in the real OpenAI / Claude wrapper
 * without touching the rest of the module.
 *
 * Per the BE-40 brief, this module is NOT registered in
 * `app.module.ts` — that step lives in the BE-40 handoff doc.
 */
@Module({
  imports: [ObservabilityModule],
  controllers: [IngredientExplainerController],
  providers: [IngredientExplanationRepository, LlmExplainerService, IngredientExplainerService],
  exports: [IngredientExplainerService],
})
export class IngredientExplainerModule {}
