import { Module } from '@nestjs/common';

import { AiModule as AiIntegrationModule } from '@/integrations/ai/ai.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';

/**
 * BE-22 — Module-level AI surface.
 *
 *   - Imports `AiIntegrationModule` (which registers the orchestrator
 *     + providers + repositories + cache).
 *   - Imports `AuthModule` for the BE-08 guard stack used by the
 *     controller.
 *   - Imports `ObservabilityModule` so the service / orchestrator can
 *     audit-log state changes.
 */
@Module({
  imports: [AiIntegrationModule, AuthModule, ObservabilityModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
