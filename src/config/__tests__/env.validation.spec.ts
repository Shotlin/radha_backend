import { EnvValidationError, validateEnv } from '../env.validation';

const baseValidConfig = {
  NODE_ENV: 'development',
  DB_HOST: 'localhost',
  DB_NAME: 'radha_test',
  DB_USER: 'postgres',
  DB_PASSWORD: 'password',
};

const baseProductionConfig = {
  NODE_ENV: 'production',
  DB_HOST: 'db.prod.example',
  DB_NAME: 'radha_prod',
  DB_USER: 'radha',
  DB_PASSWORD: 'a-very-strong-secret-1234',
  DB_SSL: 'true',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE1234',
  AWS_SECRET_ACCESS_KEY: 'secret-key-data',
  AWS_S3_BUCKET: 'radha-prod-media',
  SMS_PROVIDER: '2factor',
  TWO_FACTOR_API_KEY: 'real-key',
  TWO_FACTOR_TEMPLATE: 'tpl-1',
  JWT_ACCESS_SECRET: 'X'.repeat(64),
  JWT_REFRESH_SECRET: 'Y'.repeat(64),
  RAZORPAY_KEY_ID: 'rzp_live_example1234',
  RAZORPAY_KEY_SECRET: 'z'.repeat(24),
  RAZORPAY_WEBHOOK_SECRET: 'w'.repeat(24),
  CORS_ORIGINS: 'https://radha.app,https://admin.radha.app',
};

describe('validateEnv', () => {
  it('returns parsed env with defaults for development input', () => {
    const result = validateEnv({ ...baseValidConfig });
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
    expect(result.API_PREFIX).toBe('api');
    expect(result.DB_PORT).toBe(5432);
    expect(result.SMS_PROVIDER).toBe('mock');
  });

  it('coerces numeric strings to numbers', () => {
    const result = validateEnv({ ...baseValidConfig, PORT: '4001', DB_PORT: '5433' });
    expect(result.PORT).toBe(4001);
    expect(result.DB_PORT).toBe(5433);
    expect(typeof result.PORT).toBe('number');
  });

  it('parses CORS_ORIGINS into a trimmed array', () => {
    const result = validateEnv({ ...baseValidConfig, CORS_ORIGINS: 'http://a.com, http://b.com' });
    expect(result.CORS_ORIGINS).toEqual(['http://a.com', 'http://b.com']);
  });

  it('throws EnvValidationError when PORT is out of range', () => {
    expect(() => validateEnv({ ...baseValidConfig, PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('rejects unknown SMS_PROVIDER values', () => {
    expect(() => validateEnv({ ...baseValidConfig, SMS_PROVIDER: 'pigeon' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts a complete production config', () => {
    const result = validateEnv({ ...baseProductionConfig });
    expect(result.NODE_ENV).toBe('production');
    expect(result.DB_SSL).toBe(true);
    expect(result.SMS_PROVIDER).toBe('2factor');
  });

  it('rejects production when DB_SSL=false', () => {
    expect(() => validateEnv({ ...baseProductionConfig, DB_SSL: 'false' })).toThrow(
      /DB_SSL must be true in production/,
    );
  });

  it('rejects production when CORS_ORIGINS contains "*"', () => {
    expect(() =>
      validateEnv({ ...baseProductionConfig, CORS_ORIGINS: 'https://radha.app,*' }),
    ).toThrow(/CORS_ORIGINS cannot include "\*" in production/);
  });

  it('rejects production with a placeholder JWT secret', () => {
    expect(() =>
      validateEnv({ ...baseProductionConfig, JWT_ACCESS_SECRET: 'a'.repeat(64) }),
    ).toThrow(/JWT_ACCESS_SECRET appears to be a development placeholder/);
  });

  it('rejects production with SMS_PROVIDER=mock', () => {
    expect(() => validateEnv({ ...baseProductionConfig, SMS_PROVIDER: 'mock' })).toThrow(
      /SMS_PROVIDER cannot be "mock" in production/,
    );
  });

  it('error message lists every failing variable', () => {
    try {
      validateEnv({ ...baseProductionConfig, DB_SSL: 'false', CORS_ORIGINS: 'https://r.app,*' });
      throw new Error('Expected validateEnv to throw');
    } catch (err) {
      const e = err as EnvValidationError;
      expect(e).toBeInstanceOf(EnvValidationError);
      const variables = e.entries.map((entry) => entry.variable);
      expect(variables).toEqual(expect.arrayContaining(['DB_SSL', 'CORS_ORIGINS']));
    }
  });
});
