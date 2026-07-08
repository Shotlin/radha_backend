import { FcmService } from '../fcm.service';

const buildConfig = () =>
  ({
    isProduction: false,
    isStaging: false,
    redis: {} as never,
  }) as unknown as ConstructorParameters<typeof FcmService>[0];

describe('FcmService — disabled paths', () => {
  let originalJson: string | undefined;
  let originalB64: string | undefined;

  beforeEach(() => {
    originalJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
    originalB64 = process.env.FCM_SERVICE_ACCOUNT_BASE64;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.FCM_SERVICE_ACCOUNT_BASE64;
  });

  afterEach(() => {
    if (originalJson === undefined) {
      delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    } else {
      process.env.FCM_SERVICE_ACCOUNT_JSON = originalJson;
    }
    if (originalB64 === undefined) {
      delete process.env.FCM_SERVICE_ACCOUNT_BASE64;
    } else {
      process.env.FCM_SERVICE_ACCOUNT_BASE64 = originalB64;
    }
  });

  it('reports unavailable when no credentials are configured', () => {
    const svc = new FcmService(buildConfig());
    expect(svc.isAvailable()).toBe(false);
  });

  it('returns globalError result when no creds and tokens supplied', async () => {
    const svc = new FcmService(buildConfig());
    const result = await svc.send({
      tokens: ['t1', 't2'],
      title: 'T',
      body: 'B',
    });

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(2);
    expect(result.globalError).toMatch(/credentials|unavailable/i);
    expect(result.perToken).toHaveLength(2);
    expect(result.perToken.every((p) => !p.success)).toBe(true);
    expect(result.perToken.every((p) => !p.permanentFailure)).toBe(true);
  });

  it('returns no-tokens-provided when input is empty', async () => {
    const svc = new FcmService(buildConfig());
    const result = await svc.send({ tokens: [], title: 'T', body: 'B' });
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.globalError).toMatch(/no tokens/i);
  });

  it('rejects malformed JSON in FCM_SERVICE_ACCOUNT_JSON gracefully', () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = '{not-json';
    const svc = new FcmService(buildConfig());
    expect(svc.isAvailable()).toBe(false);
  });

  it('accepts valid JSON service account but defers to dynamic firebase-admin import', () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: 'service_account',
      project_id: 'fake',
      private_key: 'x',
      client_email: 'fake@fake',
    });
    const svc = new FcmService(buildConfig());
    expect(svc.isAvailable()).toBe(true);
  });

  it('deduplicates tokens before send', async () => {
    const svc = new FcmService(buildConfig());
    const result = await svc.send({
      tokens: ['t1', 't1', 't2'],
      title: 'T',
      body: 'B',
    });
    expect(result.perToken).toHaveLength(2);
  });
});
