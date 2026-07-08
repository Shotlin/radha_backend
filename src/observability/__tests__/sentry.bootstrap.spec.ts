/**
 * BE-48 Sentry bootstrap coverage.
 *
 * The bootstrap dynamically imports `@sentry/node`. We jest.mock the
 * module at the top of the file so we control the `init` /
 * `captureException` surface and can assert call shapes without
 * shipping anything to a real Sentry endpoint. Module-level state is
 * reset between tests via the exported test hook.
 */

const initMock = jest.fn();
const closeMock = jest.fn().mockResolvedValue(true);
const captureExceptionMock = jest.fn();

jest.mock('@sentry/node', () => ({
  init: initMock,
  close: closeMock,
  captureException: captureExceptionMock,
  captureMessage: jest.fn(),
  setTag: jest.fn(),
  setContext: jest.fn(),
  setUser: jest.fn(),
  withScope: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import {
  __resetSentryForTests,
  getSentryClient,
  initSentry,
  isSentryInitialized,
  shutdownSentry,
} from '../sentry.bootstrap';

describe('sentry.bootstrap', () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalEnv = process.env.NODE_ENV;
  const originalSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE;

  beforeEach(() => {
    initMock.mockReset();
    closeMock.mockClear().mockResolvedValue(true);
    captureExceptionMock.mockReset();
    __resetSentryForTests();
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  });

  afterAll(() => {
    if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn;
    if (originalEnv !== undefined) process.env.NODE_ENV = originalEnv;
    if (originalSampleRate !== undefined) process.env.SENTRY_TRACES_SAMPLE_RATE = originalSampleRate;
  });

  it('no-ops when SENTRY_DSN is unset', async () => {
    const client = await initSentry();
    expect(client).toBeNull();
    expect(initMock).not.toHaveBeenCalled();
    expect(getSentryClient()).toBeNull();
    // The bootstrap function still records that it was attempted.
    expect(isSentryInitialized()).toBe(true);
  });

  it('no-ops when SENTRY_DSN is the empty string', async () => {
    process.env.SENTRY_DSN = '';
    const client = await initSentry();
    expect(client).toBeNull();
    expect(initMock).not.toHaveBeenCalled();
    expect(getSentryClient()).toBeNull();
  });

  it('calls Sentry.init with the DSN, environment and traces sample rate when DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://public@sentry.example.com/123';
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.1';

    const client = await initSentry();

    expect(client).not.toBeNull();
    expect(initMock).toHaveBeenCalledTimes(1);
    const opts = initMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.dsn).toBe('https://public@sentry.example.com/123');
    expect(opts.environment).toBe('production');
    expect(opts.tracesSampleRate).toBe(0.1);
    expect(typeof opts.beforeSend).toBe('function');
    expect(getSentryClient()).not.toBeNull();
  });

  it('uses a 1.0 sample rate when overridden via options (staging behaviour)', async () => {
    process.env.SENTRY_DSN = 'https://public@sentry.example.com/123';

    await initSentry({ tracesSampleRate: 1.0, environment: 'staging' });

    const opts = initMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.tracesSampleRate).toBe(1.0);
    expect(opts.environment).toBe('staging');
  });

  it('beforeSend invokes the onEventCaptured budget hook for every event', async () => {
    process.env.SENTRY_DSN = 'https://public@sentry.example.com/123';
    const onEventCaptured = jest.fn();

    await initSentry({ onEventCaptured });

    const opts = initMock.mock.calls[0][0] as {
      beforeSend: (event: Record<string, unknown>) => unknown;
    };
    const result = opts.beforeSend({ level: 'error', extra: { foo: 'bar' } });

    expect(onEventCaptured).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
  });

  it('shutdownSentry drains the SDK and clears the cached client', async () => {
    process.env.SENTRY_DSN = 'https://public@sentry.example.com/123';
    await initSentry();
    expect(getSentryClient()).not.toBeNull();

    await shutdownSentry(500);

    expect(closeMock).toHaveBeenCalledWith(500);
    expect(getSentryClient()).toBeNull();
    expect(isSentryInitialized()).toBe(false);
  });
});
