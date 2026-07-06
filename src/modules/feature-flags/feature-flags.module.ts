import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagGuard } from './guards/feature-flag.guard';
import { GrowthbookProvider } from './providers/growthbook.provider';
import { LocalStaticProvider } from './providers/local-static.provider';
import { UnleashProvider } from './providers/unleash.provider';
import { FeatureFlagsService } from './services/feature-flags.service';
import { FF_PROVIDER, IFlagProvider } from './types/feature-flag.types';

/**
 * BE-47 — Feature Flags module wiring.
 *
 *   - `FF_PROVIDER` is bound to `LocalStaticProvider` by default.
 *     When we adopt Unleash or GrowthBook we swap the `useExisting`
 *     reference here without touching `FeatureFlagsService`.
 *   - The module exports `FeatureFlagsService` and `FeatureFlagGuard`
 *     so other domain modules (voice, premium upsell, etc.) can do
 *     `imports: [FeatureFlagsModule]` and use `@RequireFeatureFlag()`.
 *   - Per the BE-47 brief this module is NOT registered in
 *     `app.module.ts`; that step lives in the BE-47 handoff doc.
 */
@Module({
  imports: [AuthModule],
  controllers: [FeatureFlagsController],
  providers: [
    LocalStaticProvider,
    UnleashProvider,
    GrowthbookProvider,
    {
      provide: FF_PROVIDER,
      useExisting: LocalStaticProvider,
    },
    FeatureFlagsService,
    FeatureFlagGuard,
  ],
  exports: [FeatureFlagsService, FeatureFlagGuard, FF_PROVIDER],
})
export class FeatureFlagsModule {}

// Re-export the typed provider symbol so test/diagnostic code that
// imports `FeatureFlagsModule` only needs one import path.
export type { IFlagProvider };
export { FF_PROVIDER };
