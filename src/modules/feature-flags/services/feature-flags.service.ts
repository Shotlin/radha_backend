import { Inject, Injectable, Optional } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import { LocalStaticProvider } from '../providers/local-static.provider';
import {
  FF_OFF,
  FF_ON,
  FF_PROVIDER,
  FeatureFlagUser,
  IFeatureFlagsService,
  IFlagProvider,
  defaultVariantFor,
} from '../types/feature-flag.types';

/**
 * BE-47 — Feature-flag evaluation service.
 *
 * Responsibilities:
 *
 *   1. **Cache**. In-memory, 5-minute TTL, keyed by
 *      `${tenantId|'-'}:${userId}:${flagName}`. The TTL gives the
 *      Mobile_App the ≤ 5-minute propagation window the spec
 *      promises while keeping evaluation hot at < 1 ms after the
 *      first call.
 *
 *   2. **Per-tenant isolation**. Cache keys include `tenantId` so a
 *      tenant override never bleeds into a sibling tenant's cohort.
 *      The bucket key passed to the provider is also tenant-prefixed
 *      so two users with the same `userId` (in different tenants —
 *      shouldn't happen, but defence-in-depth) hash into independent
 *      buckets.
 *
 *   3. **Default-on-failure**. If the provider throws we (a) emit a
 *      Sentry warning with the flag name and (b) fall back to the
 *      flag's configured default — pulled from the LocalStatic table
 *      when available, otherwise `'off'`.
 *
 *   4. **Analytics**. Each evaluation emits a single
 *      `feature_flag_evaluated` breadcrumb log line. The analytics
 *      pipe (BE-29) reads these from log aggregation; we do not
 *      block on a network event emit because evaluations sit on the
 *      hot path of every request.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

@Injectable()
export class FeatureFlagsService implements IFeatureFlagsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(FF_PROVIDER) private readonly provider: IFlagProvider,
    private readonly logger: LoggerService,
    @Optional() private readonly localStatic?: LocalStaticProvider,
    @Optional()
    @Inject(ERROR_TRACKING_SERVICE)
    private readonly errorTracking?: IErrorTrackingService,
  ) {}

  async isEnabled(flagName: string, user: FeatureFlagUser): Promise<boolean> {
    const variant = await this.getVariant(flagName, user);
    return variant === FF_ON;
  }

  async getVariant(flagName: string, user: FeatureFlagUser): Promise<string> {
    const key = this.cacheKey(flagName, user);
    const cached = this.readCache(key);
    if (cached !== undefined) {
      return cached;
    }

    const variant = await this.evaluateWithFallback(flagName, user);
    this.writeCache(key, variant);
    this.emitAnalytics(flagName, variant, user);
    return variant;
  }

  async getAll(user: FeatureFlagUser): Promise<Record<string, string>> {
    let names: string[];
    try {
      names = await this.provider.list();
    } catch (err) {
      this.warnProviderFailure('list', err);
      names = await this.localStaticListSafe();
    }

    const out: Record<string, string> = {};
    for (const flagName of names) {
      out[flagName] = await this.getVariant(flagName, user);
    }
    return out;
  }

  /** Test/admin hook — purges the in-memory cache. */
  invalidateCache(): void {
    this.cache.clear();
  }

  // ── internals ──────────────────────────────────────────────────

  private cacheKey(flagName: string, user: FeatureFlagUser): string {
    const tenant = user.tenantId ?? '-';
    return `${tenant}:${user.id}:${flagName}`;
  }

  private bucketKey(user: FeatureFlagUser): string {
    // Prefix with tenantId so users in different tenants do NOT share
    // a bucket. The userId itself is enough for sticky bucketing
    // within a tenant.
    const tenant = user.tenantId ?? '-';
    return `${tenant}:${user.id}`;
  }

  private readCache(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private writeCache(key: string, value: string): void {
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private async evaluateWithFallback(
    flagName: string,
    user: FeatureFlagUser,
  ): Promise<string> {
    try {
      return await this.provider.evaluate(flagName, this.bucketKey(user));
    } catch (err) {
      this.warnProviderFailure(flagName, err);
      return this.fallbackVariant(flagName);
    }
  }

  private fallbackVariant(flagName: string): string {
    const def = this.localStatic?.getDefinition(flagName);
    return def ? defaultVariantFor(def) : FF_OFF;
  }

  private async localStaticListSafe(): Promise<string[]> {
    if (!this.localStatic) return [];
    try {
      return await this.localStatic.list();
    } catch {
      return [];
    }
  }

  private warnProviderFailure(flagName: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn('feature-flags.provider.error', {
      flag: flagName,
      providerError: message,
    });
    if (this.errorTracking) {
      this.errorTracking.captureMessage(
        `feature-flags.provider.error: ${flagName}`,
        'warning',
        { module: 'feature-flags', metadata: { flag: flagName, error: message } },
      );
    }
  }

  private emitAnalytics(
    flagName: string,
    variant: string,
    user: FeatureFlagUser,
  ): void {
    // BE-29 picks these breadcrumbs up via the structured-log
    // pipeline. We deliberately do not push synchronously to a
    // network sink — feature-flag evaluation is on the hot path of
    // every request and must not block on analytics.
    this.logger.info('feature_flag_evaluated', {
      flag: flagName,
      variant,
      userId: user.id,
      tenantId: user.tenantId ?? undefined,
    });
  }
}
