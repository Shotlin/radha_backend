import { Module } from '@nestjs/common';

import { ConfigHealthController } from './config-health.controller';
import { HealthController } from './health.controller';

/**
 * Health module — exposes liveness, readiness, and a dev-only masked
 * config dump.
 *
 * `HealthController` is dependency-free so liveness can answer even
 * when downstreams are degraded. `ConfigHealthController` consumes
 * the global `ConfigService` exported by `AppConfigModule`.
 */
@Module({
  controllers: [HealthController, ConfigHealthController],
})
export class HealthModule {}
