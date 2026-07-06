import { z } from 'zod';

import type { FlagDefinition } from '../types/feature-flag.types';

/**
 * BE-47 — Zod schemas for feature-flag config + the public response
 * envelope.
 *
 * The schemas are exported so the LocalStaticProvider can validate
 * the contents of `FEATURE_FLAGS_JSON` at boot time and reject
 * malformed config loud-and-early instead of returning silent `'off'`
 * values at runtime.
 */

export const BooleanFlagDefinitionSchema = z
  .object({
    type: z.literal('boolean'),
    default: z.boolean(),
  })
  .strict();

export const RolloutFlagDefinitionSchema = z
  .object({
    type: z.literal('rollout'),
    percentage: z.number().min(0).max(100),
    default: z.string().min(1),
    on: z.string().min(1),
  })
  .strict();

export const MultivariateFlagDefinitionSchema = z
  .object({
    type: z.literal('multivariate'),
    variants: z.array(z.string().min(1)).min(1),
    weights: z.array(z.number().nonnegative()).min(1),
    default: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.variants.length === v.weights.length, {
    message: 'variants and weights must be the same length',
    path: ['weights'],
  })
  .refine((v) => v.weights.reduce((s, w) => s + w, 0) > 0, {
    message: 'sum of weights must be > 0',
    path: ['weights'],
  });

export const FlagDefinitionSchema = z.union([
  BooleanFlagDefinitionSchema,
  RolloutFlagDefinitionSchema,
  MultivariateFlagDefinitionSchema,
]);

/** Top-level shape of `FEATURE_FLAGS_JSON` — `{ flagName: definition }`. */
export const FeatureFlagsConfigSchema = z.record(z.string().min(1), FlagDefinitionSchema);

/**
 * Use the typed union from `feature-flag.types` rather than Zod's
 * inferred shape — Zod's `.refine` on the multivariate branch
 * collapses the discriminant into `{ type?: unknown }` which loses
 * narrowing in `switch (def.type)`. The runtime parse still uses the
 * schema; we only retype the result so consumers get full TS support.
 */
export type FeatureFlagsConfig = Record<string, FlagDefinition>;

/** `GET /feature-flags/me` response envelope. */
export const FeatureFlagsMeResponseSchema = z.record(z.string().min(1), z.string());
export type FeatureFlagsMeResponse = z.infer<typeof FeatureFlagsMeResponseSchema>;
