import { Global, Module } from '@nestjs/common';

import { OffCacheRepository } from './off-cache.repository';
import { OffCacheService } from './off-cache.service';
import { OffCircuitBreakerService } from './off-circuit-breaker.service';
import { OffMapperService } from './off-mapper.service';
import { OpenFoodFactsService } from './off.service';

/**
 * Wires the OFF stack: cache repo → cache service → circuit breaker
 * → API service → response mapper. Exported globally so:
 *
 *   - `ProductLookupService` (BE-10) can fall back to OFF on miss.
 *   - `BarcodeLearningService` (BE-56) can compare community submissions
 *     against the OFF baseline.
 *   - The admin dashboard (BE-31) can read live stats.
 */
@Global()
@Module({
  providers: [
    OffCacheRepository,
    OffCacheService,
    OffCircuitBreakerService,
    OffMapperService,
    OpenFoodFactsService,
  ],
  exports: [OffCacheService, OffCircuitBreakerService, OffMapperService, OpenFoodFactsService],
})
export class OffModule {}
