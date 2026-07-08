import { LoggerService } from '@/logging/logger.service';

import { MockAiProvider } from '../providers/mock-ai.provider';
import { AiExplanationCacheRepository } from '../repositories/ai-explanation-cache.repository';
import { AiCircuitBreakerService } from '../services/ai-circuit-breaker.service';
import { LlmService } from '../services/llm.service';
import type { ILlmProvider } from '../types/ai.types';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildBreaker = (): AiCircuitBreakerService => new AiCircuitBreakerService(buildLogger());

const buildCacheRepo = (): AiExplanationCacheRepository =>
  ({
    findCached: jest.fn().mockResolvedValue(null),
    upsertCached: jest.fn().mockResolvedValue({ id: 'cache-1' }),
    incrementHit: jest.fn().mockResolvedValue(undefined),
  }) as unknown as AiExplanationCacheRepository;

const providerReturning = (text: string): ILlmProvider => ({
  name: 'gemini',
  isConfigured: () => true,
  complete: jest.fn(async () => ({
    text,
    tokensUsed: 120,
    cost: 0.001,
    provider: 'gemini' as const,
    durationMs: 300,
  })),
});

const buildService = (provider: ILlmProvider): LlmService =>
  new LlmService(provider, new MockAiProvider(), buildBreaker(), buildCacheRepo(), buildLogger());

describe('LlmService.analyzeLabelText', () => {
  it('parses a well-formed label JSON response into a structured result', async () => {
    const provider = providerReturning(
      JSON.stringify({
        productName: 'Choco Cream Biscuits',
        brand: 'SweetCo',
        category: 'Biscuits',
        ingredients: ['Wheat flour', 'Sugar', 'Palm oil', 'Cocoa solids'],
        allergens: ['wheat'],
        nutritionalInfo: { energy: 480, sugar: 32, fat: 22 },
        healthFlags: ['high sugar', 'ultra-processed'],
        summary: 'A sweet, ultra-processed biscuit high in sugar — enjoy occasionally.',
      }),
    );
    const svc = buildService(provider);

    const result = await svc.analyzeLabelText('CHOCO CREAM ... INGREDIENTS: WHEAT FLOUR, SUGAR', {
      locale: 'en',
    });

    expect(result.productName).toBe('Choco Cream Biscuits');
    expect(result.brand).toBe('SweetCo');
    expect(result.ingredients).toContain('Sugar');
    expect(result.allergens).toEqual(['wheat']);
    expect(result.nutritionalInfo).toEqual({ energy: 480, sugar: 32, fat: 22 });
    expect(result.healthFlags).toContain('high sugar');
    expect(result.summary).toContain('sugar');
    expect(result.provider).toBe('gemini');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('strips markdown code fences before parsing', async () => {
    const provider = providerReturning(
      '```json\n{"productName":"Atta","ingredients":["Whole wheat"]}\n```',
    );
    const svc = buildService(provider);

    const result = await svc.analyzeLabelText('WHOLE WHEAT ATTA');

    expect(result.productName).toBe('Atta');
    expect(result.ingredients).toEqual(['Whole wheat']);
  });

  it('returns a low-confidence warning result when the response is not JSON', async () => {
    const provider = providerReturning('sorry, I could not read this label');
    const svc = buildService(provider);

    const result = await svc.analyzeLabelText('blurry text');

    expect(result.confidence).toBe(0);
    expect(result.warnings?.[0]).toMatch(/could not parse/i);
    expect(result.productName).toBeUndefined();
  });

  it('short-circuits an empty transcript without calling the provider', async () => {
    const provider = providerReturning('{}');
    const svc = buildService(provider);

    const result = await svc.analyzeLabelText('   ');

    expect(result.confidence).toBe(0);
    expect(result.warnings?.[0]).toMatch(/empty transcript/i);
    expect(provider.complete as jest.Mock).not.toHaveBeenCalled();
  });
});
