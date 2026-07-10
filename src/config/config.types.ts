/**
 * Configuration type definitions.
 *
 * These mirror the Zod schema in `env.schema.ts`. Keep them in sync —
 * the Zod schema is the runtime source of truth, these are the
 * compile-time projections.
 */

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
  schema: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
  tls: boolean;
}

export interface S3Config {
  bucket: string;
  region: string;
  presignedUrlExpirySeconds: number;
  /** Set for a self-hosted S3-compatible store (MinIO); unset ⇒ real AWS S3. */
  endpoint?: string;
  forcePathStyle: boolean;
}

export interface CloudFrontConfig {
  domain: string;
  distributionId?: string;
  keyPairId?: string;
  privateKey?: string;
}

export interface AwsConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  s3: S3Config;
  cloudfront: CloudFrontConfig;
}

export interface SmsConfig {
  provider: '2factor' | 'mock';
  apiKey: string;
  /** 2Factor DLT template name; '' ⇒ the provider uses 2Factor's default template. */
  templateId: string;
  otpLength: number;
  otpExpirySeconds: number;
  maxAttemptsPerHour: number;
}

export interface JwtConfig {
  accessTokenSecret: string;
  refreshTokenSecret: string;
  accessTokenExpirySeconds: number;
  refreshTokenExpirySeconds: number;
  issuer: string;
  audience: string;
}

export interface CorsConfig {
  origins: string[];
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  maxAge: number;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message: string;
  skipSuccessfulRequests: boolean;
  trustProxy: boolean;
}

export interface FeatureFlags {
  enableAiOcr: boolean;
  enableLlmSummaries: boolean;
  enableAwsRekognition: boolean;
  enableOfflineSync: boolean;
  enableSubscriptions: boolean;
  enableOwnerDashboard: boolean;
  enableMarketingWebsite: boolean;
  enableOpenBeautyFacts: boolean;
  enableOpenProductsFacts: boolean;
  enableUpcItemDb: boolean;
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug' | 'verbose';
  format: 'json' | 'pretty';
  redactKeys: string[];
}

export interface ObservabilityConfig {
  sentryDsn?: string;
  sentryTracesSampleRate: number;
  auditLogEnabled: boolean;
  criticalAlertEmail?: string;
}

/**
 * BE-28 v2 — Razorpay payment configuration.
 *
 * `isLive` is the toggle every consumer reads to decide between the
 * real Razorpay SDK and the deterministic mock provider. It flips to
 * `true` only when `keyId` is non-empty, mirroring the SMS pattern.
 * Secrets are never logged: `ConfigService.getMasked('RAZORPAY_*')`
 * runs them through the secret masker.
 */
export interface PaymentsConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  isLive: boolean;
}

export type MaskedConfig = Record<string, unknown>;

export interface ValidationError {
  variable: string;
  message: string;
  received?: string;
  expected: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * IConfigService — typed config surface used by the rest of the app.
 * Phases that consume configuration should depend on this interface
 * rather than reaching into `process.env` directly.
 */
export interface IConfigService {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly apiPrefix: string;
  readonly appName: string;
  readonly appVersion: string;
  readonly isProduction: boolean;
  readonly isStaging: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;

  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly aws: AwsConfig;
  readonly sms: SmsConfig;
  readonly jwt: JwtConfig;
  readonly cors: CorsConfig;
  readonly rateLimit: RateLimitConfig;
  readonly features: FeatureFlags;
  readonly logging: LoggingConfig;
  readonly observability: ObservabilityConfig;
  readonly payments: PaymentsConfig;

  getMasked(key: string): string;
  getAll(): MaskedConfig;
}
