import { ConfigService as NestConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ConfigService } from '../config.service';
import { NodeEnv } from '../config.types';

const fakeEnv: Record<string, unknown> = {
  NODE_ENV: 'development',
  PORT: 3000,
  API_PREFIX: 'api',
  APP_NAME: 'RADHA',
  APP_VERSION: '1.0.0',
  DB_HOST: 'localhost',
  DB_PORT: 5432,
  DB_NAME: 'radha_test',
  DB_USER: 'postgres',
  DB_PASSWORD: 'p',
  DB_SSL: false,
  DB_SCHEMA: 'public',
  DB_MAX_CONNECTIONS: 20,
  DB_IDLE_TIMEOUT_MS: 30_000,
  DB_CONNECTION_TIMEOUT_MS: 5_000,
  DB_STATEMENT_TIMEOUT_MS: 30_000,
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  REDIS_PASSWORD: undefined,
  REDIS_DB: 0,
  REDIS_KEY_PREFIX: 'radha:',
  REDIS_TLS: false,
  AWS_REGION: 'ap-south-1',
  AWS_ACCESS_KEY_ID: 'AKIA',
  AWS_SECRET_ACCESS_KEY: 'super-secret-aws-key',
  AWS_S3_BUCKET: 'radha-test',
  AWS_S3_REGION: 'ap-south-1',
  AWS_S3_PRESIGNED_EXPIRY_SECONDS: 600,
  AWS_CLOUDFRONT_DOMAIN: undefined,
  SMS_PROVIDER: '2factor',
  TWO_FACTOR_API_KEY: 'super-secret-2factor-key',
  TWO_FACTOR_TEMPLATE: 'RADHA-OTP',
  OTP_LENGTH: 6,
  OTP_EXPIRY_SECONDS: 600,
  OTP_MAX_ATTEMPTS_PER_HOUR: 3,
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  JWT_ACCESS_EXPIRY_SECONDS: 1_800,
  JWT_REFRESH_EXPIRY_SECONDS: 2_592_000,
  JWT_ISSUER: 'radha-platform',
  JWT_AUDIENCE: 'radha-clients',
  CORS_ORIGINS: ['http://localhost:3000'],
  CORS_CREDENTIALS: true,
  CORS_MAX_AGE: 86_400,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 100,
  RATE_LIMIT_TRUST_PROXY: false,
  FEATURE_AI_OCR: true,
  FEATURE_LLM_SUMMARIES: false,
  FEATURE_AWS_REKOGNITION: false,
  FEATURE_OFFLINE_SYNC: true,
  FEATURE_SUBSCRIPTIONS: true,
  FEATURE_OWNER_DASHBOARD: true,
  FEATURE_MARKETING_WEBSITE: true,
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'json',
  LOG_REDACT_KEYS: ['password', 'secret'],
};

describe('ConfigService', () => {
  let service: ConfigService;
  let nestConfig: jest.Mocked<NestConfigService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ConfigService,
        {
          provide: NestConfigService,
          useValue: {
            get: jest.fn((key: string) => fakeEnv[key]),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(ConfigService);
    nestConfig = moduleRef.get(NestConfigService) as jest.Mocked<NestConfigService>;
  });

  it('exposes typed application metadata', () => {
    expect(service.nodeEnv).toBe(NodeEnv.Development);
    expect(service.port).toBe(3000);
    expect(service.apiPrefix).toBe('api');
    expect(service.isDevelopment).toBe(true);
    expect(service.isProduction).toBe(false);
  });

  it('builds the database compound', () => {
    expect(service.database).toMatchObject({
      host: 'localhost',
      port: 5432,
      name: 'radha_test',
      user: 'postgres',
      ssl: false,
      maxConnections: 20,
    });
  });

  it('treats blank optional strings as undefined', () => {
    nestConfig.get.mockImplementation((key: string) =>
      key === 'REDIS_PASSWORD' ? '' : fakeEnv[key],
    );
    expect(service.redis.password).toBeUndefined();
  });

  it('exposes nested AWS configuration', () => {
    expect(service.aws.s3.bucket).toBe('radha-test');
    expect(service.aws.s3.presignedUrlExpirySeconds).toBe(600);
    expect(service.aws.cloudfront.domain).toBe('');
  });

  it('returns SMS configuration with OTP defaults', () => {
    expect(service.sms.otpLength).toBe(6);
    expect(service.sms.otpExpirySeconds).toBe(600);
    expect(service.sms.maxAttemptsPerHour).toBe(3);
  });

  it('reports isProduction correctly', () => {
    nestConfig.get.mockImplementation((key: string) =>
      key === 'NODE_ENV' ? 'production' : fakeEnv[key],
    );
    expect(service.isProduction).toBe(true);
    expect(service.isDevelopment).toBe(false);
  });

  it('masks secrets via getMasked', () => {
    expect(service.getMasked('JWT_ACCESS_SECRET')).toMatch(/^aaaa\*+/);
    expect(service.getMasked('AWS_SECRET_ACCESS_KEY')).toMatch(/\*\*\*\*/);
    expect(service.getMasked('PORT')).toBe('3000');
  });

  it('returns "<undefined>" when reading a missing key', () => {
    nestConfig.get.mockReturnValueOnce(undefined as unknown as never);
    expect(service.getMasked('UNKNOWN_KEY')).toBe('<undefined>');
  });

  it('getAll() masks process.env secret-shaped keys', () => {
    const originalEnv = { ...process.env };
    try {
      process.env = { ...originalEnv, FAKE_PASSWORD: 'topsecret', PUBLIC_VALUE: 'visible' };
      const all = service.getAll() as Record<string, string>;
      expect(all.FAKE_PASSWORD).not.toBe('topsecret');
      expect(all.FAKE_PASSWORD).toMatch(/\*\*\*\*/);
      expect(all.PUBLIC_VALUE).toBe('visible');
    } finally {
      process.env = originalEnv;
    }
  });
});
