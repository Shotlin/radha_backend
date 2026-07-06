import { Injectable, Logger } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { AI_OPERATION_UNIT_COST, AI_VISION_DEFAULT_TIMEOUT_MS } from '../ai.constants';
import type {
  AiProvider,
  IImageRecognitionProvider,
  IOcrProvider,
  ImageFallbackCandidate,
  ImageFallbackResult,
  LabelAnalysisResult,
  OcrOptions,
  OcrResult,
} from '../types/ai.types';

type RekognitionModule = typeof import('@aws-sdk/client-rekognition');

/**
 * BE-22 — AWS Rekognition provider (paid escalation, opt-in).
 *
 * `@aws-sdk/client-rekognition` is **dynamically imported** the first
 * time a method is called so we don't pull in the SDK at boot when the
 * feature flag is off (`FEATURE_AWS_REKOGNITION=false` in dev). Mirrors
 * the lazy-load pattern used by `S3Service` and `SesEmailProvider`.
 *
 * Errors are translated into `ExternalServiceException` carrying
 * `ErrorCode.AI_SERVICE_ERROR` so the global filter renders the
 * standard envelope and Sentry sees a typed code.
 */
@Injectable()
export class AwsRekognitionProvider implements IOcrProvider, IImageRecognitionProvider {
  readonly name: AiProvider = 'rekognition';
  private readonly logger = new Logger(AwsRekognitionProvider.name);

  private sdk: RekognitionModule | null = null;
  private clientInstance: InstanceType<RekognitionModule['RekognitionClient']> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return (
      this.config.features.enableAwsRekognition &&
      this.config.aws.accessKeyId.length > 0 &&
      this.config.aws.secretAccessKey.length > 0
    );
  }

  async extractText(buffer: Buffer, _options: OcrOptions = {}): Promise<OcrResult> {
    if (!this.isConfigured()) {
      return this.unavailable('AWS Rekognition disabled or not configured');
    }
    const start = Date.now();
    try {
      const { sdk, client } = await this.ensureClient();
      const command = new sdk.DetectTextCommand({ Image: { Bytes: buffer } });
      const response = await this.withTimeout(client.send(command), AI_VISION_DEFAULT_TIMEOUT_MS);
      const lines =
        response.TextDetections?.filter((td) => td.Type === 'LINE')
          .map((td) => td.DetectedText ?? '')
          .filter(Boolean) ?? [];
      const text = lines.join('\n');
      const conf =
        (response.TextDetections?.filter((td) => td.Type === 'LINE').reduce(
          (acc, td) => acc + (td.Confidence ?? 0),
          0,
        ) ?? 0) /
        Math.max(1, lines.length) /
        100;
      return {
        success: text.length > 0,
        text,
        confidence: Number.isFinite(conf) ? conf : 0,
        provider: 'rekognition',
        cost: AI_OPERATION_UNIT_COST['ocr-text'],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.logger.error(`rekognition.extract_text.failed: ${(err as Error).message}`);
      throw new ExternalServiceException(
        'AWS Rekognition',
        err as Error,
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
  }

  async recognise(buffer: Buffer): Promise<ImageFallbackResult> {
    if (!this.isConfigured()) {
      return {
        candidates: [],
        confidence: 0,
        provider: 'rekognition',
        cost: 0,
        durationMs: 0,
      };
    }
    const start = Date.now();
    try {
      const { sdk, client } = await this.ensureClient();
      const labels = await this.withTimeout(
        client.send(
          new sdk.DetectLabelsCommand({
            Image: { Bytes: buffer },
            MaxLabels: 10,
            MinConfidence: 60,
          }),
        ),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );
      const text = await this.withTimeout(
        client.send(new sdk.DetectTextCommand({ Image: { Bytes: buffer } })),
        AI_VISION_DEFAULT_TIMEOUT_MS,
      );

      const ocrLines =
        text.TextDetections?.filter((td) => td.Type === 'LINE')
          .map((td) => td.DetectedText ?? '')
          .filter(Boolean) ?? [];
      const ocrText = ocrLines.join('\n');

      const candidates: ImageFallbackCandidate[] = [];
      // First two OCR lines are the strongest product-name candidates.
      for (const line of ocrLines.slice(0, 2)) {
        candidates.push({
          productName: line,
          confidence: 0.6,
          source: 'ocr',
        });
      }
      // Top label is a fallback category-name candidate.
      const topLabel = labels.Labels?.[0];
      if (topLabel?.Name && (topLabel.Confidence ?? 0) >= 70) {
        candidates.push({
          productName: topLabel.Name,
          confidence: (topLabel.Confidence ?? 0) / 100,
          source: 'label',
        });
      }

      return {
        candidates,
        ocrText,
        confidence: candidates[0]?.confidence ?? 0,
        provider: 'rekognition',
        cost: AI_OPERATION_UNIT_COST['image-fallback'],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.logger.error(`rekognition.recognise.failed: ${(err as Error).message}`);
      throw new ExternalServiceException(
        'AWS Rekognition',
        err as Error,
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
  }

  async analyseLabel(buffer: Buffer): Promise<LabelAnalysisResult> {
    if (!this.isConfigured()) {
      return {
        confidence: 0,
        provider: 'rekognition',
        cost: 0,
        durationMs: 0,
        warnings: ['AWS Rekognition disabled or not configured'],
      };
    }
    const start = Date.now();
    try {
      const { sdk, client } = await this.ensureClient();
      const [textRes, labelsRes] = await Promise.all([
        this.withTimeout(
          client.send(new sdk.DetectTextCommand({ Image: { Bytes: buffer } })),
          AI_VISION_DEFAULT_TIMEOUT_MS,
        ),
        this.withTimeout(
          client.send(
            new sdk.DetectLabelsCommand({
              Image: { Bytes: buffer },
              MaxLabels: 5,
              MinConfidence: 50,
            }),
          ),
          AI_VISION_DEFAULT_TIMEOUT_MS,
        ),
      ]);

      const lines =
        textRes.TextDetections?.filter((td) => td.Type === 'LINE')
          .map((td) => td.DetectedText ?? '')
          .filter(Boolean) ?? [];
      const productName = lines[0];
      const brand = lines[1];
      const category = labelsRes.Labels?.[0]?.Name?.toLowerCase();

      const confidences =
        textRes.TextDetections?.filter((td) => td.Type === 'LINE').map(
          (td) => (td.Confidence ?? 0) / 100,
        ) ?? [];
      const conf =
        confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

      return {
        productName,
        brand,
        category,
        confidence: conf,
        provider: 'rekognition',
        cost: AI_OPERATION_UNIT_COST['label-analysis'],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      this.logger.error(`rekognition.analyse_label.failed: ${(err as Error).message}`);
      throw new ExternalServiceException(
        'AWS Rekognition',
        err as Error,
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
  }

  private unavailable(reason: string): OcrResult {
    return {
      success: false,
      text: '',
      confidence: 0,
      provider: 'rekognition',
      cost: 0,
      durationMs: 0,
      warnings: [reason],
    };
  }

  private async ensureClient(): Promise<{
    sdk: RekognitionModule;
    client: InstanceType<RekognitionModule['RekognitionClient']>;
  }> {
    if (this.sdk && this.clientInstance) {
      return { sdk: this.sdk, client: this.clientInstance };
    }
    const mod = (await import('@aws-sdk/client-rekognition').catch(
      () => null,
    )) as RekognitionModule | null;
    if (!mod) {
      throw new ExternalServiceException(
        'AWS Rekognition',
        new Error('@aws-sdk/client-rekognition is not installed'),
        ErrorCode.AI_SERVICE_ERROR,
      );
    }
    this.sdk = mod;
    this.clientInstance = new mod.RekognitionClient({
      region: this.config.aws.region,
      credentials: {
        accessKeyId: this.config.aws.accessKeyId,
        secretAccessKey: this.config.aws.secretAccessKey,
      },
    });
    return { sdk: this.sdk, client: this.clientInstance };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Rekognition request timed out after ${ms}ms`)), ms),
      ),
    ]);
  }
}
