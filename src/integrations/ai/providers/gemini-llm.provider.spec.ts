import { ExternalServiceException } from '@/common/errors/business.exception';
import { ConfigService } from '@/config/config.service';

import { GeminiLlmProvider } from './gemini-llm.provider';

/** Build a minimal fetch Response stand-in. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function okGeneration(text: string, finishReason = 'STOP') {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { totalTokenCount: 42 },
  });
}

describe('GeminiLlmProvider', () => {
  const config = { isTest: false } as unknown as ConfigService;
  let provider: GeminiLlmProvider;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_MODEL;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key-123';
    delete process.env.GEMINI_MODEL;
    provider = new GeminiLlmProvider(config);
    // Skip real backoff sleeps so retry tests run instantly.
    jest.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.GEMINI_API_KEY = originalKey;
    process.env.GEMINI_MODEL = originalModel;
    jest.restoreAllMocks();
  });

  it('returns parsed text + tokens and authenticates via header, not the URL', async () => {
    fetchMock.mockResolvedValueOnce(okGeneration('hello world'));

    const result = await provider.complete('hi');

    expect(result.text).toBe('hello world');
    expect(result.tokensUsed).toBe(42);
    expect(result.provider).toBe('gemini');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The API key must never appear in the URL query string.
    expect(url).not.toContain('test-key-123');
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-123');
  });

  it('requests structured JSON output when options.json is set', async () => {
    fetchMock.mockResolvedValueOnce(okGeneration('{"ok":true}'));

    await provider.complete('give me json', { json: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('omits responseMimeType when json is not requested', async () => {
    fetchMock.mockResolvedValueOnce(okGeneration('plain text'));

    await provider.complete('prose please');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it('routes to the per-call model override', async () => {
    fetchMock.mockResolvedValueOnce(okGeneration('routed'));

    await provider.complete('hi', { model: 'gemini-2.5-pro' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('gemini-2.5-pro:generateContent');
  });

  it('marks results truncated when the model hits MAX_TOKENS', async () => {
    fetchMock.mockResolvedValueOnce(okGeneration('partial', 'MAX_TOKENS'));

    const result = await provider.complete('long');

    expect(result.truncated).toBe(true);
  });

  it('retries a transient 503 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, { ok: false, status: 503 }))
      .mockResolvedValueOnce(okGeneration('recovered'));

    const result = await provider.complete('hi');

    expect(result.text).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable 400', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'bad request' }, { ok: false, status: 400 }),
    );

    await expect(provider.complete('hi')).rejects.toBeInstanceOf(ExternalServiceException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the max attempts on persistent 503', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'down' }, { ok: false, status: 503 }));

    await expect(provider.complete('hi')).rejects.toBeInstanceOf(ExternalServiceException);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a network error but treats a timeout (AbortError) as terminal', async () => {
    const network = Object.assign(new Error('socket hang up'), { name: 'TypeError' });
    fetchMock.mockRejectedValueOnce(network).mockResolvedValueOnce(okGeneration('after-retry'));

    const ok = await provider.complete('hi');
    expect(ok.text).toBe('after-retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValue(abort);
    await expect(provider.complete('hi')).rejects.toBeInstanceOf(ExternalServiceException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws immediately when the API key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(provider.complete('hi')).rejects.toBeInstanceOf(ExternalServiceException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is configured when a key is present outside the test profile', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('reports not-configured under the test profile even with a key', () => {
    const testProvider = new GeminiLlmProvider({ isTest: true } as unknown as ConfigService);
    expect(testProvider.isConfigured()).toBe(false);
  });
});
