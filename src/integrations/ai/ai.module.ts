import { Global, Module, type Provider } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { MediaModule } from '@/modules/media/media.module';

import { AwsRekognitionProvider } from './providers/aws-rekognition.provider';
import { GeminiLlmProvider } from './providers/gemini-llm.provider';
import { GoogleCloudVisionProvider } from './providers/google-cloud-vision.provider';
import { MockAiProvider } from './providers/mock-ai.provider';
import { NvidiaLlmProvider } from './providers/nvidia-llm.provider';
import { OpenAiLlmProvider } from './providers/openai-llm.provider';
import { AiExplanationCacheRepository } from './repositories/ai-explanation-cache.repository';
import { AiExtractionsRepository } from './repositories/ai-extractions.repository';
import { AiUsageRepository } from './repositories/ai-usage.repository';
import { AiCircuitBreakerService } from './services/ai-circuit-breaker.service';
import { AiOrchestratorService } from './services/ai-orchestrator.service';
import { LlmService } from './services/llm.service';
import { OcrService } from './services/ocr.service';
import { UsageTrackerService } from './services/usage-tracker.service';
import {
  IMAGE_RECOGNITION_PROVIDER_TOKEN,
  LLM_PROVIDER_TOKEN,
  OCR_PROVIDER_TOKEN,
} from './types/ai.types';

/**
 * BE-22 — AI/OCR integration module.
 *
 * Provider selection mirrors `AwsModule`'s S3 token pattern:
 *
 *   - `IMAGE_RECOGNITION_PROVIDER_TOKEN` resolves to:
 *       Google Cloud Vision  if GOOGLE_APPLICATION_CREDENTIALS is set,
 *       AWS Rekognition      if `FEATURE_AWS_REKOGNITION` is on and
 *                            AWS creds exist,
 *       Mock                 otherwise.
 *
 *   - `LLM_PROVIDER_TOKEN` resolves to:
 *       OpenRouter/OpenAI    if OPENROUTER_API_KEY or OPENAI_API_KEY is set,
 *       NVIDIA (DeepSeek)    if NVIDIA_API_KEY is set,
 *       Gemini               if GEMINI_API_KEY is set,
 *       Mock                 otherwise.
 *
 *   - `OCR_PROVIDER_TOKEN` resolves to the active image provider so
 *     the orchestrator can call `analyseLabel` for server-side OCR
 *     fallback.
 *
 * Imports:
 *   - `AuthModule`  — controller uses the BE-08 guard stack.
 *   - `MediaModule` — orchestrator resolves `mediaId` → S3 buffer.
 *   - `AwsModule`   — already `@Global`, gives us `S3_SERVICE_TOKEN`.
 */

const imageRecognitionProvider: Provider = {
  provide: IMAGE_RECOGNITION_PROVIDER_TOKEN,
  inject: [ConfigService, GoogleCloudVisionProvider, AwsRekognitionProvider, MockAiProvider],
  useFactory: (
    config: ConfigService,
    gcv: GoogleCloudVisionProvider,
    rek: AwsRekognitionProvider,
    mock: MockAiProvider,
  ) => {
    if (gcv.isConfigured()) return gcv;
    if (rek.isConfigured()) return rek;
    void config;
    return mock;
  },
};

const llmProvider: Provider = {
  provide: LLM_PROVIDER_TOKEN,
  inject: [OpenAiLlmProvider, NvidiaLlmProvider, GeminiLlmProvider, MockAiProvider],
  useFactory: (
    openai: OpenAiLlmProvider,
    nvidia: NvidiaLlmProvider,
    gemini: GeminiLlmProvider,
    mock: MockAiProvider,
  ) => {
    if (openai.isConfigured()) return openai;
    if (nvidia.isConfigured()) return nvidia;
    if (gemini.isConfigured()) return gemini;
    return mock;
  },
};

const ocrProvider: Provider = {
  provide: OCR_PROVIDER_TOKEN,
  inject: [AwsRekognitionProvider, MockAiProvider],
  useFactory: (rek: AwsRekognitionProvider, mock: MockAiProvider) =>
    rek.isConfigured() ? rek : mock,
};

@Global()
@Module({
  imports: [AuthModule, MediaModule],
  providers: [
    // Repositories
    AiExtractionsRepository,
    AiUsageRepository,
    AiExplanationCacheRepository,
    // Provider implementations
    GoogleCloudVisionProvider,
    AwsRekognitionProvider,
    OpenAiLlmProvider,
    GeminiLlmProvider,
    NvidiaLlmProvider,
    MockAiProvider,
    // Provider tokens
    imageRecognitionProvider,
    llmProvider,
    ocrProvider,
    // Services
    AiCircuitBreakerService,
    OcrService,
    UsageTrackerService,
    LlmService,
    AiOrchestratorService,
  ],
  exports: [
    AiOrchestratorService,
    OcrService,
    LlmService,
    UsageTrackerService,
    AiCircuitBreakerService,
    AiExtractionsRepository,
    AiUsageRepository,
    AiExplanationCacheRepository,
    GoogleCloudVisionProvider,
    AwsRekognitionProvider,
    OpenAiLlmProvider,
    GeminiLlmProvider,
    NvidiaLlmProvider,
    MockAiProvider,
    IMAGE_RECOGNITION_PROVIDER_TOKEN,
    LLM_PROVIDER_TOKEN,
    OCR_PROVIDER_TOKEN,
  ],
})
export class AiModule {}
