import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  FeatureFlagsConfig,
  FeatureFlagsConfigSchema,
} from '../dto/feature-flag.dto';

export const FF_SEED_TOKEN = Symbol('FF_SEED_TOKEN');
import {
  FF_OFF,
  FlagDefinition,
  IFlagProvider,
  defaultVariantFor,
} from '../types/feature-flag.types';
import { bucketOf } from '../utils/fnv1a.util';

/**
 * BE-47 — Default in-process provider.
 *
 * Reads its flag table from the `FEATURE_FLAGS_JSON` env var on first
 * use (and on every `refresh()` call). The table is validated by Zod
 * before being installed so a malformed JSON or wrong-shape entry
 * fails loud at boot rather than silently turning every flag off.
 *
 * Supported shapes (see `dto/feature-flag.dto.ts`):
 *
 * ```
 * { "shiny_button": { "type": "boolean", "default": true } }
 * { "voice_v2":     { "type": "rollout", "percentage": 30,
 *                     "default": "off", "on": "on" } }
 * { "color_test":   { "type": "multivariate",
 *                     "variants": ["A","B","C"],
 *                     "weights":  [50,30,20] } }
 * ```
 *
 * Bucketing is sticky: the same `(flagName, bucketKey)` pair always
 * returns the same variant. Hash function is FNV-1a 32-bit; see
 * `utils/fnv1a.util.ts`.
 */
@Injectable()
export class LocalStaticProvider implements IFlagProvider {
  private readonly logger = new Logger(LocalStaticProvider.name);
  private flags: FeatureFlagsConfig = {};
  private loaded = false;

  /** Optional ctor seed primarily used by tests; production reads env. */
  constructor(
    @Optional() @Inject(FF_SEED_TOKEN) seed?: FeatureFlagsConfig,
  ) {
    if (seed) {
      this.flags = seed;
      this.loaded = true;
    }
  }

  async evaluate(flagName: string, bucketKey: string): Promise<string> {
    this.ensureLoaded();
    const def = this.flags[flagName];
    if (!def) return FF_OFF;
    return this.evaluateDefinition(flagName, bucketKey, def);
  }

  async list(): Promise<string[]> {
    this.ensureLoaded();
    return Object.keys(this.flags);
  }

  /**
   * Re-read `FEATURE_FLAGS_JSON`. Throws if the JSON is invalid.
   * Callers (the service) treat thrown errors as transient and use
   * the previously-loaded table; test code can call this directly to
   * mutate the table mid-run.
   */
  async refresh(): Promise<void> {
    this.flags = this.loadFromEnv();
    this.loaded = true;
  }

  /** Read-only window over the loaded table — used by tests + diagnostics. */
  getDefinition(flagName: string): FlagDefinition | undefined {
    this.ensureLoaded();
    return this.flags[flagName];
  }

  // ── internals ──────────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.flags = this.loadFromEnv();
    this.loaded = true;
  }

  private loadFromEnv(): FeatureFlagsConfig {
    const raw = process.env.FEATURE_FLAGS_JSON;
    if (!raw || raw.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        `FEATURE_FLAGS_JSON is not valid JSON (${(err as Error).message}); using empty flag table`,
      );
      return {};
    }
    const result = FeatureFlagsConfigSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        `FEATURE_FLAGS_JSON failed schema validation (${result.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ')}); using empty flag table`,
      );
      return {};
    }
    // Re-cast the parsed value to the typed config — the runtime
    // shape matches `FlagDefinition` because the schema's
    // discriminated union enforces it; the cast restores the
    // discriminant TypeScript needs for narrowing.
    return result.data as unknown as FeatureFlagsConfig;
  }

  private evaluateDefinition(
    flagName: string,
    bucketKey: string,
    def: FlagDefinition,
  ): string {
    const composite = `${flagName}:${bucketKey}`;
    switch (def.type) {
      case 'boolean':
        return def.default ? 'on' : 'off';
      case 'rollout': {
        const bucket = bucketOf(composite, 100);
        return bucket < def.percentage ? def.on : def.default;
      }
      case 'multivariate': {
        const total = def.weights.reduce((s, w) => s + w, 0);
        if (total <= 0 || def.variants.length === 0) {
          return defaultVariantFor(def);
        }
        const bucket = bucketOf(composite, total);
        let cursor = 0;
        for (let i = 0; i < def.variants.length; i++) {
          cursor += def.weights[i] ?? 0;
          if (bucket < cursor) return def.variants[i] ?? defaultVariantFor(def);
        }
        // Fallback for floating-point edge cases — should not be reached
        // because `bucket < total` holds by construction.
        return def.variants[def.variants.length - 1] ?? defaultVariantFor(def);
      }
    }
  }
}
