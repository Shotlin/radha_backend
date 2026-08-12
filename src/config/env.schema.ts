import { z } from 'zod';

/**
 * Zod schema for all environment variables consumed by the server.
 *
 * Default tier (`EnvSchema`) is permissive enough for development and
 * test, but every variable still has a precise type. The strict tier
 * (`ProductionEnvSchema`) layered on top tightens secret length, forces
 * TLS, and forbids CORS wildcards in production/staging.
 *
 * BE-01 used soft parsers in `app.config.ts`. From BE-02 onward the
 * Nest `ConfigModule` invokes `validateEnv` (in `env.validation.ts`)
 * on boot, which routes the raw env through one of these schemas.
 */

/**
 * Boolean-from-env coercer.
 *
 * `z.coerce.boolean()` would call `Boolean(value)` which makes
 * `Boolean("false") === true` — a classic Zod gotcha that silently
 * inverts every `_=false` env var. This helper accepts both real
 * booleans and the conventional string forms, and treats anything
 * that isn't a recognised "true" as `false`.
 */
const envBool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes' || s === 'on';
    });


export const NodeEnvSchema = z.enum(['development', 'test', 'staging', 'production']);

const csv = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

export const EnvSchema = z.object({
  // ───── Application ─────────────────────────────────────────────────
  NODE_ENV: NodeEnvSchema.default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z.string().min(1).default('api'),
  APP_NAME: z.string().default('RADHA'),
  APP_VERSION: z.string().default('1.0.0'),

  // ───── Database (used in BE-05) ───────────────────────────────────
  DB_HOST: z.string().min(1, 'DB_HOST is required').default('localhost'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required').default('radha_dev'),
  DB_USER: z.string().min(1, 'DB_USER is required').default('postgres'),
  DB_PASSWORD: z.string().default(''),
  DB_SSL: envBool(false),
  DB_SCHEMA: z.string().default('public'),
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(20),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

  // ───── Redis (used in BE-24, BE-32, BE-46) ────────────────────────
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
  REDIS_KEY_PREFIX: z.string().default('radha:'),
  REDIS_TLS: envBool(false),

  // ───── AWS (used in BE-13, BE-21, BE-23) ──────────────────────────
  AWS_REGION: z.string().min(1).default('ap-south-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  AWS_S3_BUCKET: z.string().default('radha-dev-media'),
  AWS_S3_REGION: z.string().default('ap-south-1'),
  AWS_S3_PRESIGNED_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(43200).default(600),
  // Self-hosted S3-compatible target (MinIO) instead of real AWS — unset
  // means "talk to real AWS S3" (the SDK's own default). When set, this is
  // the PUBLIC URL a phone can actually reach; MinIO itself may sit behind
  // an internal-only port with nginx proxying this public path to it.
  AWS_S3_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  // MinIO (and most non-AWS S3-compatible stores) need path-style bucket
  // addressing (`endpoint/bucket/key`) rather than AWS's virtual-hosted
  // style (`bucket.endpoint/key`).
  AWS_S3_FORCE_PATH_STYLE: envBool(false),
  AWS_CLOUDFRONT_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  AWS_CLOUDFRONT_DISTRIBUTION_ID: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  AWS_CLOUDFRONT_KEY_PAIR_ID: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  AWS_CLOUDFRONT_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // ───── Firebase Admin SDK (BE-24 FCM + Phase 13 auth) ─────────────
  // Service-account credentials for `firebase-admin`, shared by two
  // consumers: FcmService (push notifications, BE-24) and
  // FirebaseAuthVerifierService (Google Sign-In token verification,
  // Phase 13). Previously only read via raw `process.env` inside
  // fcm.service.ts because these were never added to the typed schema —
  // fixed here since Phase 13 needs them validated the same way every
  // other secret is. Either form is accepted; `_BASE64` is convenient
  // for env systems that mangle raw JSON with embedded newlines.
  FCM_SERVICE_ACCOUNT_JSON: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  FCM_SERVICE_ACCOUNT_BASE64: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // ───── SMS / OTP (2Factor.in — BE-06) ─────────────────────────────
  SMS_PROVIDER: z.enum(['2factor', 'mock']).default('mock'),
  // 2Factor.in transactional OTP API key. Blank (or a `dev-*` placeholder)
  // in non-production ⇒ the deterministic mock provider, so local OTP flows
  // work without a real account or spending SMS credits.
  TWO_FACTOR_API_KEY: z.string().default(''),
  // DLT-approved template name registered in the 2Factor dashboard. Optional —
  // when blank the provider falls back to 2Factor's default OTP template.
  TWO_FACTOR_TEMPLATE: z.string().default(''),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  OTP_MAX_ATTEMPTS_PER_HOUR: z.coerce.number().int().min(1).max(20).default(3),

  // ───── JWT (used from BE-06 onward) ───────────────────────────────
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 chars')
    .default('a'.repeat(32)),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 chars')
    .default('b'.repeat(32)),
  // Access tokens are intentionally short-lived; the mobile client silently
  // rotates them with the refresh token. The refresh session is the user's
  // actual remembered-login window and slides forward on activity.
  JWT_ACCESS_EXPIRY_SECONDS: z.coerce.number().int().positive().default(3_600),
  JWT_REFRESH_EXPIRY_SECONDS: z.coerce.number().int().positive().default(604_800),
  JWT_ISSUER: z.string().default('radha-platform'),
  JWT_AUDIENCE: z.string().default('radha-clients'),

  // ───── CORS ───────────────────────────────────────────────────────
  CORS_ORIGINS: csv('http://localhost:3000'),
  CORS_CREDENTIALS: envBool(true),
  CORS_MAX_AGE: z.coerce.number().int().nonnegative().default(86_400),

  // ───── Rate Limiting (BE-08, BE-46) ───────────────────────────────
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_TRUST_PROXY: envBool(false),

  // ───── Feature Flags ──────────────────────────────────────────────
  FEATURE_AI_OCR: envBool(true),
  FEATURE_LLM_SUMMARIES: envBool(false),
  FEATURE_AWS_REKOGNITION: envBool(false),
  FEATURE_OFFLINE_SYNC: envBool(true),
  FEATURE_SUBSCRIPTIONS: envBool(true),
  FEATURE_OWNER_DASHBOARD: envBool(true),
  FEATURE_MARKETING_WEBSITE: envBool(true),
  FEATURE_OPEN_BEAUTY_FACTS: envBool(true),
  FEATURE_OPEN_PRODUCTS_FACTS: envBool(true),
  FEATURE_UPC_ITEM_DB: envBool(true),

  // ───── Logging (BE-04) ────────────────────────────────────────────
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  LOG_REDACT_KEYS: csv('password,secret,token,key,authorization'),

  // ───── Observability (BE-04, refined in BE-48) ────────────────────
  SENTRY_DSN: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  AUDIT_LOG_ENABLED: envBool(true),
  CRITICAL_ALERT_EMAIL: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // ───── Affiliate Engine (BE-41) ───────────────────────────────────
  /**
   * Shared secret used to verify HMAC-SHA256 signatures on the
   * `/api/v1/affiliate/revenue` partner webhook. Optional in dev so
   * tests / local stacks can run without a real partner integration.
   */
  AFFILIATE_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),

  // ───── Payments / Razorpay (BE-28 v2) ─────────────────────────────
  /**
   * Razorpay test/live API credentials. Empty in dev means the
   * RazorpayService falls back to the deterministic mock provider so
   * local payment flows work without hitting Razorpay's network.
   * Production validation (`ProductionEnvSchema`) requires real
   * non-empty values.
   *
   * `RAZORPAY_WEBHOOK_SECRET` is the dashboard-configured secret used
   * to verify `X-Razorpay-Signature` on inbound webhooks. Treat it
   * the same as `AFFILIATE_WEBHOOK_SECRET` — optional in dev,
   * required in production.
   */
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),

  // ───── Demo / testing credentials ─────────────────────────────────
  // Defense-in-depth valve around the two fixed, hardcoded demo numbers
  // in AuthService (9999999999 / 8000000000). Defaults true to preserve
  // current behavior exactly -- demoOtpFor() only ever matches those two
  // exact numbers so this was never a real bypass risk, but the flag lets
  // it be switched off without a code change if that assumption changes.
  DEMO_ACCOUNTS_ENABLED: envBool(true),
  // When both are set, requests for DEMO_MOBILE always receive DEMO_OTP
  // and SMS delivery is skipped. Safe to set in any non-production env.
  DEMO_MOBILE: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  DEMO_OTP: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

/**
 * Production / staging hardening:
 *   - Real DB password (≥ 16 chars)
 *   - TLS to DB
 *   - Real JWT secrets (≥ 64 chars)
 *   - Real AWS + 2Factor credentials
 *   - No CORS wildcard
 *
 * The merged shape is checked when `NODE_ENV` is `production` or `staging`.
 */
const requireRealSecret = (label: string, min: number) =>
  z
    .string()
    .min(min, `${label} must be at least ${min} chars in production`)
    .refine(
      (val) => !/^[ab]+$/i.test(val),
      `${label} appears to be a development placeholder; replace with a real secret in production`,
    );

export const ProductionEnvSchema = EnvSchema.extend({
  CORS_ORIGINS: z
    .string()
    .refine((val) => !val.split(',').some((s) => s.trim() === '*'), {
      message: 'CORS_ORIGINS cannot include "*" in production',
    })
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  DB_SSL: z
    .string()
    .or(z.boolean())
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'))
    .refine((v) => v === true, 'DB_SSL must be true in production'),
  DB_PASSWORD: z.string().min(16, 'DB_PASSWORD must be at least 16 chars in production'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required in production'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required in production'),
  AWS_S3_BUCKET: z.string().min(1, 'AWS_S3_BUCKET is required in production'),
  TWO_FACTOR_API_KEY: z.string().min(1, 'TWO_FACTOR_API_KEY is required in production'),
  SMS_PROVIDER: z
    .enum(['2factor', 'mock'])
    .refine((v) => v !== 'mock', 'SMS_PROVIDER cannot be "mock" in production'),
  JWT_ACCESS_SECRET: requireRealSecret('JWT_ACCESS_SECRET', 64),
  JWT_REFRESH_SECRET: requireRealSecret('JWT_REFRESH_SECRET', 64),
  RAZORPAY_KEY_ID: z.string().min(1, 'RAZORPAY_KEY_ID is required in production'),
  RAZORPAY_KEY_SECRET: z.string().min(16, 'RAZORPAY_KEY_SECRET must be at least 16 chars in production'),
  RAZORPAY_WEBHOOK_SECRET: z
    .string()
    .min(16, 'RAZORPAY_WEBHOOK_SECRET must be at least 16 chars in production'),
}).refine(
  (env) => Boolean(env.FCM_SERVICE_ACCOUNT_JSON) || Boolean(env.FCM_SERVICE_ACCOUNT_BASE64),
  {
    message:
      'One of FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_BASE64 is required in production (used by both push notifications and Firebase Auth Google Sign-In)',
    path: ['FCM_SERVICE_ACCOUNT_JSON'],
  },
);

export type Env = z.infer<typeof EnvSchema>;
export type ProductionEnv = z.infer<typeof ProductionEnvSchema>;
