/**
 * BE-47 — Feature Flags type contracts.
 *
 * The platform speaks two languages:
 *
 *   1. **Provider language** — `IFlagProvider`. Stateless evaluator
 *      that takes a flag name + a stable bucket key and returns a
 *      variant string (`'on' | 'off' | <variantName>`). Providers
 *      know nothing about NestJS, tenants, caching, or analytics —
 *      that's all in the service.
 *
 *   2. **Service language** — `FeatureFlagsService`. Wraps the active
 *      provider with a 5-minute in-memory cache, per-tenant bucket
 *      keying, sticky bucketing, default-on-miss fallback, and an
 *      analytics breadcrumb on every evaluation.
 *
 * Adding a new provider (Unleash, GrowthBook, ConfigCat, …) is a
 * matter of implementing `IFlagProvider`. Tests only ever mock this
 * interface.
 */

/** Provider injection token; bound to LocalStaticProvider by default. */
export const FF_PROVIDER = Symbol('FF_PROVIDER');

/** Special variant meaning "flag did not match / off / disabled". */
export const FF_OFF = 'off';
/** Special variant meaning "flag matched / on / enabled". */
export const FF_ON = 'on';

/**
 * The minimum surface every provider must expose. The service treats
 * any thrown error as a transient failure and falls back to the
 * flag's configured default (or `'off'` if no default is known).
 */
export interface IFlagProvider {
  /**
   * Evaluate a single flag against a stable bucket key.
   *
   * @returns the variant string. `'off'` is returned for unknown flags
   *          so consumers can treat unknowns as disabled by default.
   */
  evaluate(flagName: string, bucketKey: string): Promise<string>;

  /** List all flag names known to this provider. */
  list(): Promise<string[]>;

  /**
   * Refresh internal state (e.g. re-read JSON from env, re-fetch from
   * a remote service). The default LocalStaticProvider is essentially
   * a no-op past the first invocation; remote providers will hit the
   * network here.
   */
  refresh(): Promise<void>;
}

/** Discriminator for the static-config flag definition format. */
export type FlagType = 'boolean' | 'rollout' | 'multivariate';

/** A simple boolean flag — either on for everyone or off for everyone. */
export interface BooleanFlagDefinition {
  type: 'boolean';
  /** When true the provider returns `'on'`, otherwise `'off'`. */
  default: boolean;
}

/**
 * Gradual rollout. We hash `${flagName}:${bucketKey}` with FNV-1a, mod
 * 100, and compare to `percentage`. A bucket below the threshold gets
 * the `on` variant (default `'on'`); the rest stay on `default`.
 *
 * `default` is also the fallback when the provider throws.
 */
export interface RolloutFlagDefinition {
  type: 'rollout';
  /** [0, 100] — share of bucket-keys that should receive `on`. */
  percentage: number;
  /** Variant returned for the cohort that did NOT win the bucket. */
  default: string;
  /** Variant returned for the cohort that DID win the bucket. */
  on: string;
}

/**
 * Multi-armed bandit / multivariate flag. The bucket key is mapped to
 * a single arm using `weights[]` (weights need not sum to 100).
 */
export interface MultivariateFlagDefinition {
  type: 'multivariate';
  variants: string[];
  weights: number[];
  /** Variant returned when the provider throws or `variants` is empty. */
  default?: string;
}

/** Discriminated union the static provider's JSON config supports. */
export type FlagDefinition =
  | BooleanFlagDefinition
  | RolloutFlagDefinition
  | MultivariateFlagDefinition;

/** A multivariate variant pair, kept around for typed config reuse. */
export interface FlagVariant {
  name: string;
  weight: number;
}

/**
 * Service contract — what controllers / guards / decorators consume.
 * Kept minimal on purpose so the rest of the codebase doesn't depend
 * on provider internals.
 */
export interface IFeatureFlagsService {
  isEnabled(flagName: string, user: FeatureFlagUser): Promise<boolean>;
  getVariant(flagName: string, user: FeatureFlagUser): Promise<string>;
  getAll(user: FeatureFlagUser): Promise<Record<string, string>>;
}

/**
 * Subset of `AuthenticatedUser` we depend on. We keep it narrow on
 * purpose so unit tests do not have to fabricate the full auth user.
 */
export interface FeatureFlagUser {
  id: string;
  tenantId?: string | null;
}

/**
 * Resolves the default variant for a flag definition. Used both by
 * the LocalStaticProvider (when miss) and by the service (when the
 * provider throws). Public so tests can pin the contract.
 */
export function defaultVariantFor(def: FlagDefinition | undefined): string {
  if (!def) return FF_OFF;
  switch (def.type) {
    case 'boolean':
      return def.default ? FF_ON : FF_OFF;
    case 'rollout':
      return def.default;
    case 'multivariate':
      return def.default ?? def.variants[0] ?? FF_OFF;
  }
}
