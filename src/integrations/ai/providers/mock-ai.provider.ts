import { Injectable, Logger } from '@nestjs/common';

import type {
  AiProvider,
  IImageRecognitionProvider,
  ILlmProvider,
  IOcrProvider,
  ImageFallbackResult,
  LabelAnalysisResult,
  LlmOptions,
  LlmResult,
  OcrOptions,
  OcrResult,
} from '../types/ai.types';

/**
 * BE-22 — Deterministic mock provider for dev / CI / unit tests.
 *
 * Implements every AI provider interface so `AiOrchestratorService`
 * can swap to it whenever upstream credentials aren't configured.
 * Returns canned, plausibly-shaped responses so downstream consumers
 * (BE-40, BE-45) can wire up against it without network access.
 */
@Injectable()
export class MockAiProvider implements IOcrProvider, IImageRecognitionProvider, ILlmProvider {
  readonly name: AiProvider = 'mock';
  private readonly logger = new Logger(MockAiProvider.name);

  async extractText(_buffer: Buffer, options: OcrOptions = {}): Promise<OcrResult> {
    this.logger.warn('mock.ocr.extract');
    const preExtracted = options.preExtractedText;
    const text = preExtracted ?? 'EXP: 31/12/2026 BATCH: ABC1234';
    return {
      success: true,
      text,
      confidence: options.preExtractedConfidence ?? 0.85,
      provider: 'mock',
      cost: 0,
      durationMs: 5,
    };
  }

  async recognise(_buffer: Buffer): Promise<ImageFallbackResult> {
    this.logger.warn('mock.image.recognise');
    return {
      candidates: [
        {
          productName: 'Mock Product',
          brand: 'Mock Brand',
          confidence: 0.7,
          source: 'ocr',
        },
      ],
      ocrText: 'Mock Product\nMock Brand\nNet wt 100g',
      confidence: 0.7,
      provider: 'mock',
      cost: 0,
      durationMs: 10,
    };
  }

  async analyseLabel(_buffer: Buffer): Promise<LabelAnalysisResult> {
    this.logger.warn('mock.image.analyse_label');
    return {
      productName: 'Mock Product',
      brand: 'Mock Brand',
      category: 'snacks',
      ingredients: ['mock ingredient 1', 'mock ingredient 2'],
      allergens: [],
      nutritionalInfo: {},
      confidence: 0.75,
      provider: 'mock',
      cost: 0,
      durationMs: 10,
    };
  }

  async complete(prompt: string, options: LlmOptions = {}): Promise<LlmResult> {
    this.logger.warn('mock.llm.complete', { promptLength: prompt.length });
    const text =
      `[mock-llm] ` +
      (prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt) +
      ` (locale=${options.locale ?? 'en'})`;
    return {
      text,
      tokensUsed: Math.min(50, Math.ceil(prompt.length / 4)),
      cost: 0,
      provider: 'mock',
      durationMs: 5,
    };
  }

  isConfigured(): boolean {
    return true;
  }
}
