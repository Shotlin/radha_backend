import { Module, Provider } from '@nestjs/common';

import { ObservabilityModule } from '@/observability/observability.module';

import { QuotaGuard } from './guards/quota.guard';
import { REDIS_QUOTA_PORT, USER_TIER_PORT } from './ports/redis-quota.port';
import { DefaultUserTierAdapter } from './providers/default-user-tier.adapter';
import { IoRedisQuotaAdapter } from './providers/ioredis-quota.adapter';
import { QuotaConfigService } from './services/quota-config.service';
import { RateLimitService } from './services/rate-limit.service';

/**
 * BE-46 — Free-Tier Rate Limiting & Quotas module.
 *
 * Wires up:
 *   - `RateLimitService`        public service entrypoint
 *   - `QuotaConfigService`      static per-tier limit table
 *   - `QuotaGuard`              `@Quota('scan' | 'save')` enforcer
 *   - `REDIS_QUOTA_PORT`        bound to `IoRedisQuotaAdapter`
 *                               (lazy-loads `ioredis`; degrades to
 *                               no-op when unavailable)
 *   - `USER_TIER_PORT`          bound to `DefaultUserTierAdapter`
 *                               (DB lookup; defaults to
 *                               `free_consumer` on any failure)
 *
 * `ObservabilityModule` is `@Global()` so we just rely on the
 * existing `AuditLogService` / `LoggerService` injection points
 * without re-importing.
 *
 * The module deliberately does not register itself in `app.module.ts`
 * — wiring lives with the consuming domain modules (BE-15 scans,
 * future saved-products) that import this module to use `QuotaGuard`
 * and `RateLimitService`.
 */
const redisQuotaProvider: Provider = {
  provide: REDIS_QUOTA_PORT,
  useExisting: IoRedisQuotaAdapter,
};

const userTierProvider: Provider = {
  provide: USER_TIER_PORT,
  useExisting: DefaultUserTierAdapter,
};

@Module({
  imports: [ObservabilityModule],
  providers: [
    /* Adapters */
    IoRedisQuotaAdapter,
    DefaultUserTierAdapter,

    /* Port bindings */
    redisQuotaProvider,
    userTierProvider,

    /* Services + guard */
    QuotaConfigService,
    RateLimitService,
    QuotaGuard,
  ],
  exports: [
    RateLimitService,
    QuotaConfigService,
    QuotaGuard,
    REDIS_QUOTA_PORT,
    USER_TIER_PORT,
  ],
})
export class RateLimitingModule {}
