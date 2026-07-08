import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import type { IngredientExplanationRow } from '@/db/schema/ingredient-explanations';
import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import { IngredientExplanationRepository } from '../repositories/ingredient-explanation.repository';
import { IngredientExplainerService } from '../services/ingredient-explainer.service';
import { LlmExplainerService } from '../services/llm-explainer.service';

describe('IngredientExplainerService', () => {
  let service: IngredientExplainerService;
  let repo: jest.Mocked<IngredientExplanationRepository>;
  let llm: jest.Mocked<LlmExplainerService>;
  let errorTracking: jest.Mocked<IErrorTrackingService>;

  const cachedRow: IngredientExplanationRow = {
    ingredientSlug: 'palm-oil',
    description: 'Palm oil is a vegetable oil derived from oil palm fruit.',
    healthConsiderations: 'High in saturated fat. Consume in moderation.',
    confidence: 'high',
    language: 'en',
    generatedBy: 'mock-llm-stub-v1',
    generatedAt: new Date('2024-06-01T00:00:00Z'),
  };

  beforeEach(async () => {
    const repoMock: jest.Mocked<IngredientExplanationRepository> = {
      findOne: jest.fn(),
      insertIfMissing: jest.fn(),
    } as unknown as jest.Mocked<IngredientExplanationRepository>;

    const llmMock = {
      modelName: 'mock-llm-stub-v1',
      generate: jest.fn(),
    } as unknown as jest.Mocked<LlmExplainerService>;

    const errorTrackingMock: jest.Mocked<IErrorTrackingService> = {
      captureException: jest.fn(),
      captureMessage: jest.fn(),
      setUser: jest.fn(),
      clearUser: jest.fn(),
      addBreadcrumb: jest.fn(),
      setTag: jest.fn(),
      setContext: jest.fn(),
    };

    const loggerMock = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
      log: jest.fn(),
      logError: jest.fn(),
    } as unknown as LoggerService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngredientExplainerService,
        { provide: IngredientExplanationRepository, useValue: repoMock },
        { provide: LlmExplainerService, useValue: llmMock },
        { provide: LoggerService, useValue: loggerMock },
        { provide: ERROR_TRACKING_SERVICE, useValue: errorTrackingMock },
      ],
    }).compile();

    service = module.get(IngredientExplainerService);
    repo = module.get(IngredientExplanationRepository);
    llm = module.get(LlmExplainerService);
    errorTracking = module.get(ERROR_TRACKING_SERVICE);
  });

  describe('cache hit', () => {
    it('returns the cached row without calling the LLM', async () => {
      repo.findOne.mockResolvedValue(cachedRow);

      const result = await service.getExplanation('palm-oil', 'en');

      expect(result.ingredientSlug).toBe('palm-oil');
      expect(result.description).toBe(cachedRow.description);
      expect(result.cached).toBe(true);
      expect(result.confidence).toBe('high');
      expect(llm.generate).not.toHaveBeenCalled();
    });

    it('looks up cache by (slug, locale) — different locale is a different cache entry', async () => {
      repo.findOne.mockResolvedValue(null);
      llm.generate.mockResolvedValue({
        description: 'पाम तेल',
        healthConsiderations: 'संतृप्त वसा अधिक है।',
        confidence: 'medium',
        modelName: 'mock-llm-stub-v1',
      });
      repo.insertIfMissing.mockImplementation(async (data) => ({
        ingredientSlug: data.ingredientSlug,
        description: data.description,
        healthConsiderations: data.healthConsiderations,
        confidence: data.confidence,
        language: data.language ?? 'en',
        generatedBy: data.generatedBy,
        generatedAt: new Date(),
      }));

      await service.getExplanation('palm-oil', 'hi');

      expect(repo.findOne).toHaveBeenCalledWith('palm-oil', 'hi');
      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'palm-oil', language: 'hi' }),
      );
    });
  });

  describe('cache miss', () => {
    beforeEach(() => {
      repo.findOne.mockResolvedValue(null);
    });

    it('calls the LLM and persists the result idempotently', async () => {
      llm.generate.mockResolvedValue({
        description: 'A description.',
        healthConsiderations: 'Some considerations.',
        confidence: 'medium',
        modelName: 'mock-llm-stub-v1',
      });
      repo.insertIfMissing.mockImplementation(async (data) => ({
        ingredientSlug: data.ingredientSlug,
        description: data.description,
        healthConsiderations: data.healthConsiderations,
        confidence: data.confidence,
        language: data.language ?? 'en',
        generatedBy: data.generatedBy,
        generatedAt: new Date('2024-06-15T00:00:00Z'),
      }));

      const result = await service.getExplanation('sodium-nitrite', 'en');

      expect(llm.generate).toHaveBeenCalledTimes(1);
      expect(repo.insertIfMissing).toHaveBeenCalledWith(
        expect.objectContaining({
          ingredientSlug: 'sodium-nitrite',
          language: 'en',
          generatedBy: 'mock-llm-stub-v1',
          confidence: 'medium',
        }),
      );
      expect(result.cached).toBe(false);
      expect(result.confidence).toBe('medium');
    });

    it('passes the 10s timeout to the LLM provider', async () => {
      llm.generate.mockResolvedValue({
        description: 'd',
        healthConsiderations: 'h',
        confidence: 'low',
        modelName: 'mock-llm-stub-v1',
      });
      repo.insertIfMissing.mockResolvedValue({
        ingredientSlug: 'salt',
        description: 'd',
        healthConsiderations: 'h',
        confidence: 'low',
        language: 'en',
        generatedBy: 'mock-llm-stub-v1',
        generatedAt: new Date(),
      });

      await service.getExplanation('salt');

      expect(llm.generate).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 10_000 }),
      );
    });
  });

  describe('graceful failure', () => {
    it('returns the fallback shape and captures the exception when the LLM throws', async () => {
      repo.findOne.mockResolvedValue(null);
      llm.generate.mockRejectedValue(new Error('LLM provider unreachable'));

      const result = await service.getExplanation('palm-oil', 'en');

      expect(result).toEqual({
        ingredientSlug: 'palm-oil',
        description: 'Explanation unavailable',
        healthConsiderations: '',
        confidence: 'low',
        language: 'en',
        cached: false,
      });
      expect(errorTracking.captureException).toHaveBeenCalledTimes(1);
      expect(errorTracking.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          module: 'ingredient-explainer',
          metadata: expect.objectContaining({ slug: 'palm-oil', locale: 'en' }),
        }),
      );
      // Failure path must not persist to the cache.
      expect(repo.insertIfMissing).not.toHaveBeenCalled();
    });

    it('returns the fallback when the LLM call times out', async () => {
      repo.findOne.mockResolvedValue(null);
      llm.generate.mockRejectedValue(new Error('LLM explainer timed out after 10000ms'));

      const result = await service.getExplanation('salt');

      expect(result.description).toBe('Explanation unavailable');
      expect(result.confidence).toBe('low');
      expect(errorTracking.captureException).toHaveBeenCalledTimes(1);
    });

    it('still returns the fallback if the persistence step itself fails', async () => {
      repo.findOne.mockResolvedValue(null);
      llm.generate.mockResolvedValue({
        description: 'd',
        healthConsiderations: 'h',
        confidence: 'low',
        modelName: 'mock-llm-stub-v1',
      });
      repo.insertIfMissing.mockRejectedValue(new Error('DB unavailable'));

      const result = await service.getExplanation('salt');

      expect(result.description).toBe('Explanation unavailable');
      expect(errorTracking.captureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('locale handling', () => {
    it('falls back to "en" when locale is missing', async () => {
      repo.findOne.mockResolvedValue(cachedRow);

      await service.getExplanation('palm-oil');

      expect(repo.findOne).toHaveBeenCalledWith('palm-oil', 'en');
    });

    it('falls back to "en" when locale is unsupported', async () => {
      repo.findOne.mockResolvedValue(cachedRow);

      await service.getExplanation('palm-oil', 'fr');

      expect(repo.findOne).toHaveBeenCalledWith('palm-oil', 'en');
    });

    it.each(['en', 'hi', 'ta', 'te', 'bn', 'mr'])(
      'accepts supported locale "%s" verbatim',
      async (locale) => {
        repo.findOne.mockResolvedValue({ ...cachedRow, language: locale });

        await service.getExplanation('palm-oil', locale);

        expect(repo.findOne).toHaveBeenCalledWith('palm-oil', locale);
      },
    );
  });

  describe('slug normalisation', () => {
    it('normalises mixed-case input before cache lookup', async () => {
      repo.findOne.mockResolvedValue(cachedRow);

      await service.getExplanation('Palm Oil');

      expect(repo.findOne).toHaveBeenCalledWith('palm-oil', 'en');
    });

    it('strips invalid characters before cache lookup', async () => {
      repo.findOne.mockResolvedValue(cachedRow);

      await service.getExplanation('palm__oil!!');

      expect(repo.findOne).toHaveBeenCalledWith('palm-oil', 'en');
    });

    it('rejects an unusable slug with BadRequestException', async () => {
      await expect(service.getExplanation('!!!')).rejects.toThrow(BadRequestException);
      await expect(service.getExplanation('')).rejects.toThrow(BadRequestException);
    });
  });

  describe('property: any string slug never crashes', () => {
    it.each([
      'normal-slug',
      'Mixed Case With Spaces',
      '   leading and trailing   ',
      '🌶 chilli powder',
      '日本語',
      '!!!---!!!',
      'a'.repeat(2048),
      'multi___under_scores',
      'A1-B2-C3',
    ])('handles %p without throwing', async (input) => {
      repo.findOne.mockResolvedValue(null);
      llm.generate.mockResolvedValue({
        description: 'd',
        healthConsiderations: 'h',
        confidence: 'low',
        modelName: 'mock-llm-stub-v1',
      });
      repo.insertIfMissing.mockImplementation(async (data) => ({
        ingredientSlug: data.ingredientSlug,
        description: data.description,
        healthConsiderations: data.healthConsiderations,
        confidence: data.confidence,
        language: data.language ?? 'en',
        generatedBy: data.generatedBy,
        generatedAt: new Date(),
      }));

      try {
        const result = await service.getExplanation(input);
        // If it returned, the contract holds.
        expect(result.ingredientSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      } catch (err) {
        // The only acceptable failure mode is BadRequestException for
        // inputs that normalise to empty.
        expect(err).toBeInstanceOf(BadRequestException);
      }
    });
  });

  describe('tenant-agnostic caching', () => {
    it('does not require or use a tenant id', async () => {
      // Call twice — neither call passes a tenant id, both should hit
      // the same cache row.
      repo.findOne.mockResolvedValue(cachedRow);

      const a = await service.getExplanation('palm-oil', 'en');
      const b = await service.getExplanation('palm-oil', 'en');

      expect(a.ingredientSlug).toBe(b.ingredientSlug);
      expect(a.cached).toBe(true);
      expect(b.cached).toBe(true);
      // Repo lookup is the only persistence interaction.
      expect(repo.findOne).toHaveBeenCalledTimes(2);
      expect(repo.insertIfMissing).not.toHaveBeenCalled();
    });
  });
});
