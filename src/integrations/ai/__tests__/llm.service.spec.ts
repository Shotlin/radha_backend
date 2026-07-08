import { LoggerService } from '@/logging/logger.service';

import { MockAiProvider } from '../providers/mock-ai.provider';
import { AiExplanationCacheRepository } from '../repositories/ai-explanation-cache.repository';
import { AiCircuitBreakerService } from '../services/ai-circuit-breaker.service';
import { LlmService } from '../services/llm.service';
import type { ILlmProvider, LlmResult } from '../types/ai.types';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildBreaker = () => new AiCircuitBreakerService(buildLogger());

const successProvider = (): ILlmProvider => ({
  name: 'openai',
  isConfigured: () => true,
  complete: jest.fn(async () => ({
    text: '{"title":"Sugar","summary":"A sweetener.","whatItIs":"Crystalline sucrose.","healthImpact":"High intake raises calorie load.","commonUses":["sweets","baking"],"childSafetyNote":"Limit for under-2s."}',
    tokensUsed: 80,
    cost: 0.005,
    provider: 'openai' as const,
    durationMs: 250,
  })),
});

const failingProvider = (): ILlmProvider => ({
  name: 'openai',
  isConfigured: () => true,
  complete: jest.fn(async () => {
    throw new Error('upstream timeout');
  }),
});

const unconfiguredProvider = (): ILlmProvider => ({
  name: 'openai',
  isConfigured: () => false,
  complete: jest.fn(async () => {
    throw new Error('should not be called');
  }),
});

const buildCacheRepo = (
  cached: Awaited<ReturnType<AiExplanationCacheRepository['findCached']>> = null,
): AiExplanationCacheRepository =>
  ({
    findCached: jest.fn().mockResolvedValue(cached),
    upsertCached: jest.fn().mockResolvedValue({ id: 'cache-1' }),
    incrementHit: jest.fn().mockResolvedValue(undefined),
  }) as unknown as AiExplanationCacheRepository;

describe('LlmService.complete', () => {
  it('routes through the configured provider', async () => {
    const provider = successProvider();
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    const result = await svc.complete('hello');
    expect(result.provider).toBe('openai');
    expect(provider.complete as jest.Mock).toHaveBeenCalled();
  });

  it('falls back to mock when provider is not configured', async () => {
    const provider = unconfiguredProvider();
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    const result = await svc.complete('hello');
    expect(result.provider).toBe('mock');
    expect(provider.complete as jest.Mock).not.toHaveBeenCalled();
  });

  it('falls back to mock and records circuit failure on error (graceful failure — Req T-v2.3)', async () => {
    const provider = failingProvider();
    const breaker = buildBreaker();
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      breaker,
      buildCacheRepo(),
      buildLogger(),
    );
    const result = await svc.complete('hello');
    expect(result.provider).toBe('mock');
    expect(result.truncated).toBe(true);
    // Circuit breaker should have recorded the failure.
    expect(breaker.getState('openai')).toBe('closed'); // single failure < threshold
  });

  it('short-circuits when breaker is open without invoking provider', async () => {
    const provider = successProvider();
    const breaker = buildBreaker();
    // Force breaker open by hammering 5 failures.
    for (let i = 0; i < 5; i += 1) breaker.recordFailure('openai');
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      breaker,
      buildCacheRepo(),
      buildLogger(),
    );
    const result = await svc.complete('hello');
    expect(result.provider).toBe('mock');
    expect(provider.complete as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('LlmService.buildTemplateSummary', () => {
  it('returns sensible default when summary is empty', () => {
    const svc = new LlmService(
      successProvider(),
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    expect(svc.buildTemplateSummary({})).toContain('No data');
  });

  it('emits totals + match-rate percentage when present', () => {
    const svc = new LlmService(
      successProvider(),
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    const out = svc.buildTemplateSummary({
      reportType: 'audit',
      summary: { totalScans: 100, matchedScans: 75, expiredItems: 5 },
    });
    expect(out).toContain('Total scans: 100');
    expect(out).toContain('Match rate: 75%');
    expect(out).toContain('Expired items: 5');
  });

  it('handles totalScans=0 without dividing by zero', () => {
    const svc = new LlmService(
      successProvider(),
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    expect(
      svc.buildTemplateSummary({
        summary: { totalScans: 0, matchedScans: 0 },
      }),
    ).toContain('Match rate: 0%');
  });
});

describe('LlmService.generateSummary', () => {
  it('uses template when provider not configured (free path)', async () => {
    const provider = unconfiguredProvider();
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    const result = await svc.generateSummary({
      reportType: 'audit',
      summary: { totalScans: 50 },
    });
    expect(result.cost).toBe(0);
    expect(result.text).toContain('Total scans: 50');
  });

  it('uses LLM when provider is configured', async () => {
    const provider = successProvider();
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    const result = await svc.generateSummary({ summary: { totalScans: 5 } });
    expect(result.provider).toBe('openai');
  });
});

describe('LlmService.explainIngredient (Req 45)', () => {
  it('returns cached payload without invoking the LLM', async () => {
    const cachedRow = {
      id: 'cache-1',
      operation: 'ingredient-explanation',
      cacheKey: 'sugar',
      locale: 'en',
      ruleVersion: '1.0.0',
      response: {
        slug: 'sugar',
        title: 'Sugar (cached)',
        summary: 'Cached summary',
        whatItIs: 'Cached body',
        healthImpact: 'Cached impact',
        commonUses: [],
      },
      provider: 'openai',
    } as unknown as Awaited<ReturnType<AiExplanationCacheRepository['findCached']>>;
    const provider = successProvider();
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(cachedRow),
      buildLogger(),
    );
    const out = await svc.explainIngredient('SUGAR');
    expect(out.cached).toBe(true);
    expect(out.title).toBe('Sugar (cached)');
    expect(out.cost).toBe(0);
    expect(provider.complete as jest.Mock).not.toHaveBeenCalled();
  });

  it('persists a new explanation on cache miss', async () => {
    const cacheRepo = buildCacheRepo();
    const provider = successProvider();
    const svc = new LlmService(
      provider,
      new MockAiProvider(),
      buildBreaker(),
      cacheRepo,
      buildLogger(),
    );
    const out = await svc.explainIngredient('sugar');
    expect(out.cached).toBe(false);
    expect(out.title).toBe('Sugar');
    expect(out.commonUses).toEqual(['sweets', 'baking']);
    expect(cacheRepo.upsertCached as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('returns sensible fallback when LLM emits non-JSON', async () => {
    const broken: ILlmProvider = {
      name: 'openai',
      isConfigured: () => true,
      complete: jest.fn(
        async (): Promise<LlmResult> => ({
          text: 'definitely not json',
          tokensUsed: 5,
          cost: 0.001,
          provider: 'openai',
          durationMs: 10,
        }),
      ),
    };
    const svc = new LlmService(
      broken,
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    const out = await svc.explainIngredient('palm-oil');
    // Fallback summary uses title-cased slug and an "unavailable" line.
    expect(out.title).toBe('Palm Oil');
    expect(out.summary).toContain('unavailable');
  });

  it('strips markdown fences before JSON.parse', async () => {
    const fenced: ILlmProvider = {
      name: 'openai',
      isConfigured: () => true,
      complete: jest.fn(
        async (): Promise<LlmResult> => ({
          text: '```json\n{"title":"X","summary":"y","whatItIs":"z","healthImpact":"q","commonUses":["a"]}\n```',
          tokensUsed: 5,
          cost: 0.001,
          provider: 'openai',
          durationMs: 10,
        }),
      ),
    };
    const svc = new LlmService(
      fenced,
      new MockAiProvider(),
      buildBreaker(),
      buildCacheRepo(),
      buildLogger(),
    );
    const out = await svc.explainIngredient('x');
    expect(out.title).toBe('X');
    expect(out.commonUses).toEqual(['a']);
  });
});
