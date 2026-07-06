import type { AiCircuitBreakerService } from './ai-circuit-breaker.service';
import { LlmService } from './llm.service';
import type { MockAiProvider } from '../providers/mock-ai.provider';
import type { AiExplanationCacheRepository } from '../repositories/ai-explanation-cache.repository';
import type { ILlmProvider, LlmResult } from '../types/ai.types';

/**
 * Structured-output resilience for analyzeLabelText.
 *
 * `options.json` asks Gemini for native JSON, but a live check showed not every
 * model/credential enforces `responseMimeType` — it returned prose-wrapped JSON.
 * The label parser must still recover the object regardless of fences or prose.
 */
describe('LlmService.analyzeLabelText — tolerant JSON extraction', () => {
  function buildWith(text: string) {
    const result: LlmResult = {
      text,
      tokensUsed: 10,
      cost: 0.001,
      provider: 'gemini',
      durationMs: 5,
    };
    const provider = {
      name: 'gemini',
      isConfigured: () => true,
      complete: jest.fn().mockResolvedValue(result),
    } as unknown as ILlmProvider;
    const mock = { complete: jest.fn() } as unknown as MockAiProvider;
    const breaker = {
      isAllowed: () => true,
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    } as unknown as AiCircuitBreakerService;
    const cacheRepo = {} as unknown as AiExplanationCacheRepository;
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    return new LlmService(provider, mock, breaker, cacheRepo, logger as never);
  }

  const PAYLOAD =
    '{"productName":"Parle-G","brand":"Parle","ingredients":["wheat flour","sugar"],' +
    '"allergens":["wheat"],"nutritionalInfo":{},"healthFlags":["high sugar"],"summary":"A sweet biscuit."}';

  it('parses pure JSON', async () => {
    const service = buildWith(PAYLOAD);
    const r = await service.analyzeLabelText('parle-g label');
    expect(r.productName).toBe('Parle-G');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('parses fenced ```json blocks', async () => {
    const service = buildWith('```json\n' + PAYLOAD + '\n```');
    const r = await service.analyzeLabelText('parle-g label');
    expect(r.productName).toBe('Parle-G');
  });

  it('parses JSON wrapped in prose (the live Gemini failure mode)', async () => {
    const service = buildWith(
      'Here is the JSON requested:\n```json\n' + PAYLOAD + '\n```\nHope that helps!',
    );
    const r = await service.analyzeLabelText('parle-g label');
    expect(r.productName).toBe('Parle-G');
    expect(r.healthFlags).toContain('high sugar');
  });

  it('parses JSON embedded in prose without fences', async () => {
    const service = buildWith('Sure! ' + PAYLOAD + ' Let me know if you need more.');
    const r = await service.analyzeLabelText('parle-g label');
    expect(r.productName).toBe('Parle-G');
  });

  it('degrades gracefully when there is no JSON at all', async () => {
    const service = buildWith('I could not read this label, sorry.');
    const r = await service.analyzeLabelText('garbled');
    expect(r.confidence).toBe(0);
    expect(r.warnings?.length).toBeGreaterThan(0);
  });
});
