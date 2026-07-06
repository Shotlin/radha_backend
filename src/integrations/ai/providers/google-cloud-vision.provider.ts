import { Injectable, Logger } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { AI_OPERATION_UNIT_COST, AI_VISION_DEFAULT_TIMEOUT_MS } from '../ai.constants';
import type {
  AiProvider,
  IImageRecognitionProvider,
  ImageFallbackCandidate,
  ImageFallbackResult,
  LabelAnalysisResult,
} from '../types/ai.types';

type VisionModule = typeof import('@google-cloud/vision');

/**
 * BE-22 v2 ADDENDUM — Google Cloud Vision provider.
 *
 * Driver requirement: Req 38 (`POST /api/v1/scan/image-fallback`,
 * owned by BE-45) needs an image-recognition provider for the OCR
 * fallback when ML Kit on-device fails to read a barcode. This
 * implementation backs the `IImageRecognitionProvider` interface
 * documented in `ai.types.ts`.
 *
 * Lazy-loaded via `import('@google-cloud/vision').catch(() => null)`
 * so the API stays up if the package isn't installed. Authentication
 * uses `GOOGLE_APPLICATION_CREDENTIALS` (service-account JSON path)
 * the same way the rest of the GCP SDK does — read from env directly
 * since BE-22 doesn't add new typed config keys.
 */
@Injectable()
export class GoogleCloudVisionProvider implements IImageRecognitionProvider {
  readonly name: AiProvider = 'google-vision';
  private readonly logger = new Logger(GoogleCloudVisionProvider.name);

  private sdk: VisionModule | null = null;
  private clientInstance: InstanceType<VisionModule['ImageAnnotatorClient']> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    // Google's SDK uses ambient credentials. We treat the presence of
    // `GOOGLE_APPLICATION_CREDENTIALS` *or* `GOOGLE_CLOUD_PROJECT` as
    // "configured". Tests patch `process.env` directly.
    if (this.config.isTest) return false;
    return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT);
  }

  async recognise(buffer: Buffer): Promise<ImageFallbackResult> {
    if (!this.isConfigured()) {
      return this.empty('Google Cloud Vision not configured');
    }
    const start = Date.now();
    try {
      const { client } = await this.ensureClient();
      const [textRes] = await this.withTimeout(
        client.textDetection({ image: { content: buffer } }),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );
      const [labelsRes] = await this.withTimeout(
        client.labelDetection({ image: { content: buffer } }),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );
      const [logoRes] = await this.withTimeout(
        client.logoDetection({ image: { content: buffer } }),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );

      const text = textRes.fullTextAnnotation?.text ?? '';
      const lines = text
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const candidates: ImageFallbackCandidate[] = [];
      for (const line of lines.slice(0, 3)) {
        candidates.push({
          productName: line,
          confidence: 0.65,
          source: 'ocr',
        });
      }
      const topLabel = labelsRes.labelAnnotations?.[0];
      if (topLabel?.description && (topLabel.score ?? 0) >= 0.7) {
        candidates.push({
          productName: topLabel.description,
          confidence: topLabel.score ?? 0,
          source: 'label',
        });
      }
      const topLogo = logoRes.logoAnnotations?.[0];
      if (topLogo?.description && (topLogo.score ?? 0) >= 0.6) {
        candidates.push({
          productName: topLogo.description,
          brand: topLogo.description,
          confidence: topLogo.score ?? 0,
          source: 'logo',
        });
      }

      return {
        candidates,
        ocrText: text,
        confidence: candidates[0]?.confidence ?? 0,
        provider: 'google-vision',
        cost: AI_OPERATION_UNIT_COST['image-fallback'],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.logger.error(`gcv.recognise.failed: ${(err as Error).message}`);
      throw new ExternalServiceException(
        'Google Cloud Vision',
        err as Error,
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
  }

  async analyseLabel(buffer: Buffer): Promise<LabelAnalysisResult> {
    if (!this.isConfigured()) {
      return {
        confidence: 0,
        provider: 'google-vision',
        cost: 0,
        durationMs: 0,
        warnings: ['Google Cloud Vision not configured'],
      };
    }
    const start = Date.now();
    try {
      const { client } = await this.ensureClient();
      const [textRes] = await this.withTimeout(
        client.textDetection({ image: { content: buffer } }),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );
      const [logoRes] = await this.withTimeout(
        client.logoDetection({ image: { content: buffer } }),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );
      const [labelRes] = await this.withTimeout(
        client.labelDetection({ image: { content: buffer } }),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );

      const lines =
        textRes.fullTextAnnotation?.text
          ?.split('\n')
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      const productName = lines[0];
      const brand = logoRes.logoAnnotations?.[0]?.description ?? lines[1];
      const category = labelRes.labelAnnotations?.[0]?.description?.toLowerCase();
      const conf = labelRes.labelAnnotations?.[0]?.score ?? 0;

      return {
        productName,
        brand,
        category,
        confidence: conf,
        provider: 'google-vision',
        cost: AI_OPERATION_UNIT_COST['label-analysis'],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.logger.error(`gcv.analyse_label.failed: ${(err as Error).message}`);
      throw new ExternalServiceException(
        'Google Cloud Vision',
        err as Error,
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
  }

  private empty(reason: string): ImageFallbackResult {
    return {
      candidates: [],
      confidence: 0,
      provider: 'google-vision',
      cost: 0,
      durationMs: 0,
      ocrText: undefined,
      ean: undefined,
      ...(reason ? {} : {}),
    };
  }

  private async ensureClient(): Promise<{
    sdk: VisionModule;
    client: InstanceType<VisionModule['ImageAnnotatorClient']>;
  }> {
    if (this.sdk && this.clientInstance) {
      return { sdk: this.sdk, client: this.clientInstance };
    }
    const mod = (await import('@google-cloud/vision').catch(() => null)) as VisionModule | null;
    if (!mod) {
      throw new ExternalServiceException(
        'Google Cloud Vision',
        new Error('@google-cloud/vision is not installed'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    this.sdk = mod;
    this.clientInstance = new mod.ImageAnnotatorClient();
    return { sdk: this.sdk, client: this.clientInstance };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Vision request timed out after ${ms}ms`)), ms),
      ),
    ]);
  }
}
