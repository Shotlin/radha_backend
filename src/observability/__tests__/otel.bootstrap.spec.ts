/**
 * BE-48 OpenTelemetry bootstrap coverage.
 *
 * The OTel SDK packages (`@opentelemetry/sdk-node`,
 * `@opentelemetry/exporter-trace-otlp-http`) are intentionally NOT
 * declared as runtime dependencies in `server/package.json` — they
 * are an opt-in cost-line, only present in environments configured to
 * export traces. The bootstrap tolerates that by `await import`ing
 * them inside a try/catch and degrading to a no-op when either
 * resolves to a missing module.
 *
 * In the test environment those packages are also absent, so the
 * "endpoint set but SDK missing" path is exercised naturally without
 * any mocking.
 */

import {
  __resetOtelForTests,
  getOtelSdk,
  initOtel,
  isOtelInitialized,
  shutdownOtel,
} from '../otel.bootstrap';

describe('otel.bootstrap', () => {
  const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    __resetOtelForTests();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterAll(() => {
    if (originalEndpoint !== undefined)
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (originalEnv !== undefined) process.env.NODE_ENV = originalEnv;
  });

  it('no-ops when OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    const sdk = await initOtel();
    expect(sdk).toBeNull();
    expect(getOtelSdk()).toBeNull();
    expect(isOtelInitialized()).toBe(true); // attempt was recorded
  });

  it('no-ops when the endpoint is set to the empty string', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
    const sdk = await initOtel();
    expect(sdk).toBeNull();
    expect(getOtelSdk()).toBeNull();
  });

  it('returns null when the endpoint is set but the OTel SDK package is not installed', async () => {
    // The test environment doesn't ship `@opentelemetry/sdk-node`,
    // so the dynamic import inside `initOtel` rejects and the
    // bootstrap quietly degrades.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com/v1/traces';
    const sdk = await initOtel();
    expect(sdk).toBeNull();
    expect(getOtelSdk()).toBeNull();
  });

  it('shutdownOtel is safe to call when no SDK was started', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
    expect(getOtelSdk()).toBeNull();
  });
});
