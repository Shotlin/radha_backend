import type { ZodError } from 'zod';

import { Env, EnvSchema, ProductionEnvSchema } from './env.schema';

/**
 * Boot-time environment validator.
 *
 * Wired into `AppConfigModule` via `ConfigModule.forRoot({ validate: validateEnv })`.
 * If validation fails the function throws, which surfaces as a clear
 * fail-fast crash on `nest start` instead of a confused runtime error
 * three layers deep.
 *
 * For `staging` and `production` environments we apply the stricter
 * `ProductionEnvSchema` superset (real secrets, TLS, no CORS wildcards).
 */

export interface ValidationFailureEntry {
  variable: string;
  message: string;
  expected: string;
  received: string;
}

export class EnvValidationError extends Error {
  constructor(
    public readonly entries: ValidationFailureEntry[],
    public readonly nodeEnv: string,
  ) {
    const lines = entries.map((e) => `  - ${e.variable}: ${e.message}`).join('\n');
    super(
      `Environment validation failed (NODE_ENV=${nodeEnv}) with ${entries.length} error(s):\n${lines}`,
    );
    this.name = 'EnvValidationError';
  }
}

const isStrictEnv = (raw: unknown): boolean => raw === 'production' || raw === 'staging';

const formatZodIssues = (
  zodErr: ZodError,
  raw: Record<string, unknown>,
): ValidationFailureEntry[] =>
  zodErr.errors.map((err) => {
    const variable = err.path.length > 0 ? err.path.join('.') : '(root)';
    const receivedRaw = raw[variable];
    const received =
      receivedRaw === undefined
        ? '<missing>'
        : typeof receivedRaw === 'string' && receivedRaw.length === 0
          ? '<empty>'
          : String(receivedRaw);
    return {
      variable,
      message: err.message,
      expected: err.code,
      received,
    };
  });

export const validateEnv = (raw: Record<string, unknown>): Env => {
  const schema = isStrictEnv(raw.NODE_ENV) ? ProductionEnvSchema : EnvSchema;
  const result = schema.safeParse(raw);

  if (!result.success) {
    const entries = formatZodIssues(result.error, raw);
    // We log here so the cause is visible even when the calling layer
    // swallows the thrown error message (Nest sometimes truncates it).
    // eslint-disable-next-line no-console
    console.error('[config] Environment validation failed:');
    for (const e of entries) {
      // eslint-disable-next-line no-console
      console.error(`  - ${e.variable}: ${e.message}`);
    }
    throw new EnvValidationError(entries, String(raw.NODE_ENV ?? 'development'));
  }

  return result.data as Env;
};
