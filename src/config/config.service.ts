import { Injectable, Logger } from '@nestjs/common';
import { ConfigService as NestConfigService } from '@nestjs/config';

import {
  AwsConfig,
  CorsConfig,
  DatabaseConfig,
  FeatureFlags,
  IConfigService,
  JwtConfig,
  LoggingConfig,
  MaskedConfig,
  NodeEnv,
  ObservabilityConfig,
  PaymentsConfig,
  RateLimitConfig,
  RedisConfig,
  SmsConfig,
} from './config.types';
import { Env } from './env.schema';
import { isSecretKey, maskObject, maskSecret } from './secrets.utils';

type EnvKey = keyof Env;

/**
 * Typed wrapper around `@nestjs/config`'s `ConfigService`.
 *
 * Every consumer (BE-03 onward) injects this class instead of the
 * underlying `NestConfigService` so we get:
 *   - autocomplete on env keys,
 *   - typed compound objects (`config.database`, `config.aws.s3`, …),
 *   - automatic secret masking via `getMasked()` / `getAll()`,
 *   - environment predicates (`isProduction`, etc.).
 */
@Injectable()
export class ConfigService implements IConfigService {
  private readonly logger = new Logger(ConfigService.name);

  constructor(private readonly nestConfig: NestConfigService<Env, true>) {
    this.logger.log(`Configuration loaded for NODE_ENV=${this.nodeEnv}`);
  }

  // ───── Application ─────────────────────────────────────────────────

  get nodeEnv(): NodeEnv {
    return this.read('NODE_ENV') as NodeEnv;
  }

  get port(): number {
    return this.read('PORT');
  }

  get apiPrefix(): string {
    return this.read('API_PREFIX');
  }

  get appName(): string {
    return this.read('APP_NAME');
  }

  get appVersion(): string {
    return this.read('APP_VERSION');
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }

  get isStaging(): boolean {
    return this.nodeEnv === NodeEnv.Staging;
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === NodeEnv.Development;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.Test;
  }

  // ───── Database ────────────────────────────────────────────────────

  get database(): DatabaseConfig {
    return {
      host: this.read('DB_HOST'),
      port: this.read('DB_PORT'),
      name: this.read('DB_NAME'),
      user: this.read('DB_USER'),
      password: this.read('DB_PASSWORD'),
      ssl: this.read('DB_SSL'),
      schema: this.read('DB_SCHEMA'),
      maxConnections: this.read('DB_MAX_CONNECTIONS'),
      idleTimeoutMs: this.read('DB_IDLE_TIMEOUT_MS'),
      connectionTimeoutMs: this.read('DB_CONNECTION_TIMEOUT_MS'),
      statementTimeoutMs: this.read('DB_STATEMENT_TIMEOUT_MS'),
    };
  }

  // ───── Redis ───────────────────────────────────────────────────────

  get redis(): RedisConfig {
    return {
      host: this.read('REDIS_HOST'),
      port: this.read('REDIS_PORT'),
      password: this.readOptional('REDIS_PASSWORD'),
      db: this.read('REDIS_DB'),
      keyPrefix: this.read('REDIS_KEY_PREFIX'),
      tls: this.read('REDIS_TLS'),
    };
  }

  // ───── AWS ─────────────────────────────────────────────────────────

  get aws(): AwsConfig {
    return {
      region: this.read('AWS_REGION'),
      accessKeyId: this.read('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.read('AWS_SECRET_ACCESS_KEY'),
      s3: {
        bucket: this.read('AWS_S3_BUCKET'),
        region: this.read('AWS_S3_REGION'),
        presignedUrlExpirySeconds: this.read('AWS_S3_PRESIGNED_EXPIRY_SECONDS'),
        endpoint: this.readOptional('AWS_S3_ENDPOINT'),
        forcePathStyle: this.read('AWS_S3_FORCE_PATH_STYLE'),
      },
      cloudfront: {
        domain: this.readOptional('AWS_CLOUDFRONT_DOMAIN') ?? '',
        distributionId: this.readOptional('AWS_CLOUDFRONT_DISTRIBUTION_ID'),
        keyPairId: this.readOptional('AWS_CLOUDFRONT_KEY_PAIR_ID'),
        privateKey: this.readOptional('AWS_CLOUDFRONT_PRIVATE_KEY'),
      },
    };
  }

  // ───── SMS ─────────────────────────────────────────────────────────

  get sms(): SmsConfig {
    return {
      provider: this.read('SMS_PROVIDER'),
      apiKey: this.read('TWO_FACTOR_API_KEY'),
      templateId: this.read('TWO_FACTOR_TEMPLATE'),
      otpLength: this.read('OTP_LENGTH'),
      otpExpirySeconds: this.read('OTP_EXPIRY_SECONDS'),
      maxAttemptsPerHour: this.read('OTP_MAX_ATTEMPTS_PER_HOUR'),
    };
  }

  // ───── JWT ─────────────────────────────────────────────────────────

  get jwt(): JwtConfig {
    return {
      accessTokenSecret: this.read('JWT_ACCESS_SECRET'),
      refreshTokenSecret: this.read('JWT_REFRESH_SECRET'),
      accessTokenExpirySeconds: this.read('JWT_ACCESS_EXPIRY_SECONDS'),
      refreshTokenExpirySeconds: this.read('JWT_REFRESH_EXPIRY_SECONDS'),
      issuer: this.read('JWT_ISSUER'),
      audience: this.read('JWT_AUDIENCE'),
    };
  }

  // ───── CORS ────────────────────────────────────────────────────────

  get cors(): CorsConfig {
    return {
      origins: this.read('CORS_ORIGINS') as unknown as string[],
      credentials: this.read('CORS_CREDENTIALS'),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'X-Total-Count'],
      maxAge: this.read('CORS_MAX_AGE'),
    };
  }

  // ───── Rate limit ──────────────────────────────────────────────────

  get rateLimit(): RateLimitConfig {
    return {
      windowMs: this.read('RATE_LIMIT_WINDOW_MS'),
      max: this.read('RATE_LIMIT_MAX'),
      message: 'Too many requests, please try again later.',
      skipSuccessfulRequests: false,
      trustProxy: this.read('RATE_LIMIT_TRUST_PROXY'),
    };
  }

  // ───── Feature flags ───────────────────────────────────────────────

  get features(): FeatureFlags {
    return {
      enableAiOcr: this.read('FEATURE_AI_OCR'),
      enableLlmSummaries: this.read('FEATURE_LLM_SUMMARIES'),
      enableAwsRekognition: this.read('FEATURE_AWS_REKOGNITION'),
      enableOfflineSync: this.read('FEATURE_OFFLINE_SYNC'),
      enableSubscriptions: this.read('FEATURE_SUBSCRIPTIONS'),
      enableOwnerDashboard: this.read('FEATURE_OWNER_DASHBOARD'),
      enableMarketingWebsite: this.read('FEATURE_MARKETING_WEBSITE'),
      enableOpenBeautyFacts: this.read('FEATURE_OPEN_BEAUTY_FACTS'),
      enableOpenProductsFacts: this.read('FEATURE_OPEN_PRODUCTS_FACTS'),
      enableUpcItemDb: this.read('FEATURE_UPC_ITEM_DB'),
    };
  }

  // ───── Logging ─────────────────────────────────────────────────────

  get logging(): LoggingConfig {
    return {
      level: this.read('LOG_LEVEL'),
      format: this.read('LOG_FORMAT'),
      redactKeys: this.read('LOG_REDACT_KEYS') as unknown as string[],
    };
  }

  // ───── Observability ───────────────────────────────────────────────

  get observability(): ObservabilityConfig {
    return {
      sentryDsn: this.readOptional('SENTRY_DSN'),
      sentryTracesSampleRate: this.read('SENTRY_TRACES_SAMPLE_RATE'),
      auditLogEnabled: this.read('AUDIT_LOG_ENABLED'),
      criticalAlertEmail: this.readOptional('CRITICAL_ALERT_EMAIL'),
    };
  }

  // ───── Demo / test credentials ────────────────────────────────────

  /** Defense-in-depth valve around AuthService's two hardcoded demo
   * numbers. Defaults true (see env.schema.ts for why). */
  get demoAccountsEnabled(): boolean {
    return this.read('DEMO_ACCOUNTS_ENABLED');
  }

  /** Normalised 10-digit mobile that always receives `demoOtp`. */
  get demoMobile(): string | undefined {
    return this.readOptional('DEMO_MOBILE');
  }

  /** Hardcoded OTP returned for `demoMobile` — SMS delivery is skipped. */
  get demoOtp(): string | undefined {
    return this.readOptional('DEMO_OTP');
  }

  // ───── Affiliate (BE-41) ──────────────────────────────────────────

  /**
   * Shared HMAC secret for verifying the partner revenue webhook.
   * Returns `undefined` in dev when no secret is configured.
   */
  get affiliateWebhookSecret(): string | undefined {
    return this.readOptional('AFFILIATE_WEBHOOK_SECRET');
  }

  // ───── Payments / Razorpay (BE-28 v2) ────────────────────────────

  /**
   * Razorpay credentials + webhook secret. `isLive` flips when
   * `keyId` is non-empty — matches the SMS provider pattern. The
   * `RazorpayService` reads this single accessor to choose between
   * the real SDK provider and the deterministic mock.
   *
   * Secrets are returned as raw strings here; `getMasked()` is what
   * any logger / health-config endpoint should use instead.
   */
  get payments(): PaymentsConfig {
    const keyId = this.read('RAZORPAY_KEY_ID');
    return {
      keyId,
      keySecret: this.read('RAZORPAY_KEY_SECRET'),
      webhookSecret: this.read('RAZORPAY_WEBHOOK_SECRET'),
      isLive: keyId.length > 0,
    };
  }

  // ───── Public helpers ──────────────────────────────────────────────

  /**
   * Returns a logged-safe representation of the value associated with
   * a known env key. Always run secret values through this before
   * emitting them to logs or HTTP responses.
   */
  getMasked(key: string): string {
    const value = this.nestConfig.get(key as EnvKey, { infer: true });
    if (value === undefined || value === null) return '<undefined>';
    if (isSecretKey(key)) return maskSecret(value);
    return Array.isArray(value) ? value.join(',') : String(value);
  }

  /**
   * Used by the dev-only `/health/config` endpoint. Walks `process.env`
   * (the raw view, not the typed schema) and masks any key that looks
   * sensitive.
   */
  getAll(): MaskedConfig {
    return maskObject({ ...process.env });
  }

  // ───── Internal ────────────────────────────────────────────────────

  private read<K extends EnvKey>(key: K): Env[K] {
    return this.nestConfig.get(key, { infer: true });
  }

  private readOptional<K extends EnvKey>(key: K): Env[K] | undefined {
    const value = this.nestConfig.get(key, { infer: true });
    if (value === undefined) return undefined;
    if (typeof value === 'string' && value.length === 0) return undefined;
    return value;
  }
}
