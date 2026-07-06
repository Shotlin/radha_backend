import { Module, forwardRef, type Provider } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ProductsModule } from '@/modules/products/products.module';

import { HealthScoringController } from './health-scoring.controller';
import { HealthAssessmentsRepository } from './repositories/health-assessments.repository';
import { AllergenDetectionService } from './services/allergen-detection.service';
import { ChildSafetyService } from './services/child-safety.service';
import { ConsumptionGuidanceService } from './services/consumption-guidance.service';
import { HealthScoringService } from './services/health-scoring.service';
import { ScoringEngineService } from './services/scoring-engine.service';
import { ALLERGEN_PROFILE_SERVICE } from './tokens';
import type { AllergenProfileServicePort } from './tokens';

/**
 * BE-12 — Health Scoring module.
 *
 * Default `ALLERGEN_PROFILE_SERVICE` provider returns null for every
 * lookup. BE-37 (Allergen Profile) overrides this binding when its
 * module is imported into AppModule.
 */
const allergenProfileNoopProvider: Provider = {
  provide: ALLERGEN_PROFILE_SERVICE,
  useValue: {
    getActiveProfile: async () => null,
    getProfile: async () => null,
  } satisfies AllergenProfileServicePort,
};

@Module({
  imports: [AuthModule, forwardRef(() => ProductsModule)],
  controllers: [HealthScoringController],
  providers: [
    ScoringEngineService,
    ChildSafetyService,
    AllergenDetectionService,
    ConsumptionGuidanceService,
    HealthAssessmentsRepository,
    HealthScoringService,
    allergenProfileNoopProvider,
  ],
  exports: [
    HealthScoringService,
    ScoringEngineService,
    ChildSafetyService,
    AllergenDetectionService,
    ConsumptionGuidanceService,
    HealthAssessmentsRepository,
  ],
})
export class HealthScoringModule {}
