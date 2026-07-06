import { Inject, Injectable } from '@nestjs/common';

import { RequestContextService } from '@/common/context/request-context.service';
import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { S3_SERVICE_TOKEN } from '@/integrations/aws/aws.module';
import type { IS3Service } from '@/integrations/aws/s3/s3.types';
import { LoggerService } from '@/logging/logger.service';
import { MediaService } from '@/modules/media/media.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  AI_EXTRACTED_TEXT_MAX,
  AI_OCR_LOW_CONFIDENCE,
  AI_OPERATION_UNIT_COST,
  AI_SYSTEM_TENANT_ID,
} from '../ai.constants';
import { MockAiProvider } from '../providers/mock-ai.provider';
import { AiExtractionsRepository } from '../repositories/ai-extractions.repository';
import { AiCircuitBreakerService } from './ai-circuit-breaker.service';
import { LlmService } from './llm.service';
import { OcrService } from './ocr.service';
import { UsageTrackerService } from './usage-tracker.service';
import {
  AiOperation,
  AiProvider,
  DateRange,
  IAiOrchestratorService,
  IImageRecognitionProvider,
  IMAGE_RECOGNITION_PROVIDER_TOKEN,
  ImageFallbackResult,
  IngredientExplanationResult,
  LabelAnalysisResult,
  LlmOptions,
  LlmResult,
  OcrOptions,
  OcrResult,
  UsageStats,
} from '../types/ai.types';
import { truncateForStorage } from '../utils/ocr-text-parser.utils';

/**
 * BE-22 — Top-level façade.
 *
 *   - Single entry point for every consumer (BE-18 expiry, BE-21
 *     reports, BE-40 ingredient explainer, BE-45 image fallback).
 *   - Enforces per-tenant quotas (`UsageTrackerService.checkLimit`).
 *   - Picks the right provider, guards every paid call with the
 *     per-provider circuit breaker, falls back gracefully.
 *   - Persists every call to `ai_extractions` for audit / debug /
 *     retraining.
 *   - Logs an audit-trail entry on every successful state change.
 */
@Injectable()
export class AiOrchestratorService implements IAiOrchestratorService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly contextService: RequestContextService,
    private readonly ocrService: OcrService,
    private readonly llmService: LlmService,
    private readonly usageTracker: UsageTrackerService,
    @Inject(IMAGE_RECOGNITION_PROVIDER_TOKEN)
    private readonly imageProvider: IImageRecognitionProvider,
    private readonly mock: MockAiProvider,
    private readonly breaker: AiCircuitBreakerService,
    @Inject(S3_SERVICE_TOKEN) private readonly s3: IS3Service,
    private readonly mediaService: MediaService,
    private readonly extractionsRepo: AiExtractionsRepository,
    private readonly audit: AuditLogService,
  ) {}

  /* ─────────────────── OCR — expiry / batch / generic ─────────────────── */

  extractExpiryDate(mediaId: string, options: OcrOptions = {}): Promise<OcrResult> {
    return this.runOcr(mediaId, 'ocr-expiry', options, (text) => ({
      dates: this.ocrService.extractDates(text),
    }));
  }

  extractBatchNumber(mediaId: string, options: OcrOptions = {}): Promise<OcrResult> {
    const opts: OcrOptions = {
      ...options,
      patterns: options.patterns ?? [/\b[A-Z]{1,3}\d{4,8}\b/, /BATCH[:\s]+([A-Z0-9]+)/i],
    };
    return this.runOcr(mediaId, 'ocr-batch', opts, (text) => ({
      numbers: this.ocrService.extractNumbers(text, /\b[A-Z]{1,3}\d{4,8}\b/),
    }));
  }

  extractText(mediaId: string, options: OcrOptions = {}): Promise<OcrResult> {
    return this.runOcr(mediaId, 'ocr-text', options, (text) => ({
      text,
      productCodes: this.ocrService.extractEans(text),
    }));
  }

  /* ─────────────────── Vision — label analysis / image fallback ─────────────────── */

  async analyzeProductLabel(mediaId: string): Promise<LabelAnalysisResult> {
    const tenantId = this.tenantId();
    await this.assertLimit(tenantId, 'label-analysis');

    const provider = this.imageProvider.name;
    if (!this.breaker.isAllowed(provider)) {
      this.logger.warn('ai.label.short_circuit', { provider });
      const result = this.unavailableLabel(provider);
      await this.persistAndTrack(tenantId, 'label-analysis', result, mediaId);
      return result;
    }

    const buffer = await this.fetchMediaBuffer(mediaId);

    const start = Date.now();
    try {
      const result = await this.imageProvider.analyseLabel(buffer);
      this.breaker.recordSuccess(provider);
      result.durationMs = result.durationMs || Date.now() - start;
      await this.persistAndTrack(tenantId, 'label-analysis', result, mediaId);
      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'AiExtraction',
        resourceId: mediaId,
        userId: this.contextService.getUserId() ?? 'system',
        tenantId,
        success: true,
        metadata: {
          operation: 'label-analysis',
          provider: result.provider,
          confidence: result.confidence,
        },
      });
      return result;
    } catch (err) {
      this.breaker.recordFailure(provider);
      const fallback = this.unavailableLabel(provider, (err as Error).message);
      await this.persistAndTrack(tenantId, 'label-analysis', fallback, mediaId);
      throw err instanceof BusinessException
        ? err
        : new BusinessException(ErrorCode.AI_SERVICE_ERROR, (err as Error).message);
    }
  }

  /**
   * Analyze an OCR'd label **transcript** (text, not an image) via the LLM.
   *
   * This is the free-first consumer fallback: the mobile does on-device ML Kit
   * OCR and sends the transcript here, so we pay only for a cheap text
   * completion instead of an image-vision call. Quota-gated under the existing
   * `label-analysis` operation and persisted to the audit trail.
   */
  async analyzeLabelText(
    transcript: string,
    options: LlmOptions = {},
  ): Promise<LabelAnalysisResult> {
    if (!transcript || typeof transcript !== 'string') {
      throw new BusinessException(ErrorCode.VALIDATION_ERROR, 'transcript is required');
    }
    const tenantId = this.tenantId();
    await this.assertLimit(tenantId, 'label-analysis');

    const result = await this.llmService.analyzeLabelText(transcript, options);
    await this.persistAndTrackLabelText(tenantId, result);
    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'AiExtraction',
      resourceId: 'label-text',
      userId: this.contextService.getUserId() ?? 'system',
      tenantId,
      success: Boolean(result.productName),
      metadata: {
        operation: 'label-analysis',
        provider: result.provider,
        confidence: result.confidence,
        source: 'text',
      },
    });
    return result;
  }

  async imageFallbackScan(mediaId: string): Promise<ImageFallbackResult> {
    const tenantId = this.tenantId();
    await this.assertLimit(tenantId, 'image-fallback');

    const provider = this.imageProvider.name;
    if (!this.breaker.isAllowed(provider)) {
      const result: ImageFallbackResult = {
        candidates: [],
        confidence: 0,
        provider,
        cost: 0,
        durationMs: 0,
      };
      await this.persistImageFallback(tenantId, result, mediaId);
      return result;
    }

    const buffer = await this.fetchMediaBuffer(mediaId);
    const start = Date.now();
    try {
      const result = await this.imageProvider.recognise(buffer);
      result.durationMs = result.durationMs || Date.now() - start;
      this.breaker.recordSuccess(provider);

      // Heuristic: derive a candidate EAN from OCR text when present.
      if (result.ocrText && !result.ean) {
        const eans = this.ocrService.extractEans(result.ocrText);
        if (eans.length > 0) result.ean = eans[0];
      }

      await this.persistImageFallback(tenantId, result, mediaId);
      await this.audit.logAction({
        action: 'CREATE',
        resourceType: 'AiExtraction',
        resourceId: mediaId,
        userId: this.contextService.getUserId() ?? 'system',
        tenantId,
        success: true,
        metadata: {
          operation: 'image-fallback',
          provider: result.provider,
          candidateCount: result.candidates.length,
          eanFound: Boolean(result.ean),
        },
      });
      return result;
    } catch (err) {
      this.breaker.recordFailure(provider);
      throw err instanceof BusinessException
        ? err
        : new BusinessException(ErrorCode.AI_SERVICE_ERROR, (err as Error).message);
    }
  }

  /* ─────────────────── LLM — summaries & ingredient explainer ─────────────────── */

  async generateReportSummary(reportData: unknown, options: LlmOptions = {}): Promise<LlmResult> {
    const tenantId = this.tenantId();
    if (!this.config.features.enableLlmSummaries) {
      const text = this.llmService.buildTemplateSummary(
        (reportData as Parameters<LlmService['buildTemplateSummary']>[0]) ?? {},
      );
      const result: LlmResult = {
        text,
        tokensUsed: 0,
        cost: 0,
        provider: 'mock',
        durationMs: 1,
      };
      await this.usageTracker.trackUsage({
        tenantId,
        operation: 'report-summary',
        provider: result.provider,
        cost: result.cost,
        durationMs: result.durationMs,
        tokensUsed: result.tokensUsed,
        success: true,
        userId: this.contextService.getUserId(),
      });
      return result;
    }

    await this.assertLimit(tenantId, 'report-summary');
    const result = await this.llmService.generateSummary(
      (reportData as Parameters<LlmService['generateSummary']>[0]) ?? {},
      options,
    );
    await this.usageTracker.trackUsage({
      tenantId,
      operation: 'report-summary',
      provider: result.provider,
      cost: result.cost,
      durationMs: result.durationMs,
      tokensUsed: result.tokensUsed,
      success: true,
      userId: this.contextService.getUserId(),
    });
    return result;
  }

  async explainIngredient(
    slug: string,
    options: LlmOptions = {},
  ): Promise<IngredientExplanationResult> {
    if (!slug || typeof slug !== 'string') {
      throw new BusinessException(ErrorCode.VALIDATION_ERROR, 'Ingredient slug is required');
    }
    const tenantId = this.tenantId();
    // Cache hits don't burn budget.
    const result = await this.llmService.explainIngredient(slug, options);
    if (!result.cached) {
      await this.assertLimit(tenantId, 'ingredient-explanation');
      await this.usageTracker.trackUsage({
        tenantId,
        operation: 'ingredient-explanation',
        provider: result.provider,
        cost: result.cost,
        durationMs: result.durationMs,
        success: true,
        userId: this.contextService.getUserId(),
        metadata: { slug },
      });
    }
    return result;
  }

  /* ─────────────────── Reporting ─────────────────── */

  getUsage(tenantId: string, dateRange: DateRange): Promise<UsageStats> {
    return this.usageTracker.getUsageForTenant(tenantId, dateRange);
  }

  getEstimatedCost(operation: AiOperation, count: number): number {
    return (AI_OPERATION_UNIT_COST[operation] ?? 0) * Math.max(0, count);
  }

  /* ─────────────────── Internal helpers ─────────────────── */

  private async runOcr(
    mediaId: string,
    operation: Extract<AiOperation, 'ocr-expiry' | 'ocr-batch' | 'ocr-text'>,
    options: OcrOptions,
    enrich: (text: string) => Record<string, unknown>,
  ): Promise<OcrResult> {
    const tenantId = this.tenantId();
    await this.assertLimit(tenantId, operation);

    let result: OcrResult;
    if (options.preExtractedText !== undefined) {
      result = this.ocrService.fromPreExtracted(options);
    } else if (
      options.fallbackToPaid &&
      this.config.features.enableAwsRekognition &&
      this.breaker.isAllowed('rekognition')
    ) {
      const buffer = await this.fetchMediaBuffer(mediaId);
      try {
        // We deliberately reach for the image provider's text path; the
        // shared `IImageRecognitionProvider` interface includes one
        // when the implementation can do generic OCR.
        const labelLike = await this.imageProvider.analyseLabel(buffer);
        result = {
          success: !!labelLike.productName,
          text: [labelLike.productName, labelLike.brand].filter(Boolean).join('\n'),
          confidence: labelLike.confidence,
          provider: labelLike.provider,
          cost: labelLike.cost,
          durationMs: labelLike.durationMs,
        };
        this.breaker.recordSuccess(labelLike.provider);
      } catch (err) {
        this.breaker.recordFailure(this.imageProvider.name);
        result = {
          success: false,
          text: '',
          confidence: 0,
          provider: this.imageProvider.name,
          cost: 0,
          durationMs: 0,
          warnings: [`OCR fallback failed: ${(err as Error).message}`],
        };
      }
    } else {
      result = this.mockOcrResult();
    }

    if (result.success && result.text) {
      const enriched = enrich(result.text);
      result.extractedData = {
        ...(result.extractedData ?? {}),
        ...(enriched as Partial<typeof result.extractedData>),
      };
    }
    if (result.success && result.confidence < AI_OCR_LOW_CONFIDENCE) {
      result.warnings = [
        ...(result.warnings ?? []),
        `Low OCR confidence (${result.confidence.toFixed(2)}) — verify manually`,
      ];
    }

    await this.persistAndTrackOcr(tenantId, operation, result, mediaId);
    return result;
  }

  private async assertLimit(tenantId: string, operation: AiOperation): Promise<void> {
    const check = await this.usageTracker.checkLimit(tenantId, operation);
    if (!check.allowed) {
      throw new BusinessException(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        check.reason ?? 'AI usage limit exceeded',
        { metadata: { operation, used: check.used, limit: check.limit, resetAt: check.resetAt } },
      );
    }
  }

  private async fetchMediaBuffer(mediaId: string): Promise<Buffer> {
    const tenantId = this.contextService.getTenantId() ?? null;
    const media = await this.mediaService.getById(mediaId, tenantId).catch(() => null);
    if (!media) {
      throw new DomainNotFoundException('media_assets', mediaId);
    }
    return this.s3.downloadObject(media.s3Key);
  }

  private tenantId(): string {
    return this.contextService.getTenantId() ?? AI_SYSTEM_TENANT_ID;
  }

  private async persistAndTrackOcr(
    tenantId: string,
    operation: Extract<AiOperation, 'ocr-expiry' | 'ocr-batch' | 'ocr-text'>,
    result: OcrResult,
    mediaId: string,
  ): Promise<void> {
    await this.usageTracker.trackUsage({
      tenantId,
      operation,
      provider: result.provider,
      cost: result.cost,
      durationMs: result.durationMs,
      success: result.success,
      resourceId: mediaId,
      userId: this.contextService.getUserId(),
    });
    await this.extractionsRepo.recordSafely({
      tenantId,
      operation,
      provider: result.provider,
      sourceType: 'media',
      sourceId: mediaId,
      success: result.success ? 'true' : 'false',
      extractedText: truncateForStorage(result.text, AI_EXTRACTED_TEXT_MAX),
      extractedData: (result.extractedData ?? {}) as Record<string, unknown>,
      confidence: String(result.confidence),
      durationMs: result.durationMs,
      cost: String(result.cost),
      userId: this.contextService.getUserId() ?? null,
      requestId: this.contextService.getRequestId(),
      metadata: result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {},
    });
  }

  private async persistAndTrack(
    tenantId: string,
    operation: AiOperation,
    result: LabelAnalysisResult,
    mediaId: string,
  ): Promise<void> {
    await this.usageTracker.trackUsage({
      tenantId,
      operation,
      provider: result.provider,
      cost: result.cost,
      durationMs: result.durationMs,
      success: !!result.productName,
      resourceId: mediaId,
      userId: this.contextService.getUserId(),
    });
    await this.extractionsRepo.recordSafely({
      tenantId,
      operation,
      provider: result.provider,
      sourceType: 'media',
      sourceId: mediaId,
      success: result.productName ? 'true' : 'false',
      extractedText: truncateForStorage(
        [result.productName, result.brand, result.category].filter(Boolean).join('\n'),
        AI_EXTRACTED_TEXT_MAX,
      ),
      extractedData: {
        productName: result.productName,
        brand: result.brand,
        category: result.category,
        ingredients: result.ingredients,
        allergens: result.allergens,
        nutritionalInfo: result.nutritionalInfo,
      },
      confidence: String(result.confidence),
      durationMs: result.durationMs,
      cost: String(result.cost),
      userId: this.contextService.getUserId() ?? null,
      requestId: this.contextService.getRequestId(),
      metadata: result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {},
    });
  }

  private async persistAndTrackLabelText(
    tenantId: string,
    result: LabelAnalysisResult,
  ): Promise<void> {
    await this.usageTracker.trackUsage({
      tenantId,
      operation: 'label-analysis',
      provider: result.provider,
      cost: result.cost,
      durationMs: result.durationMs,
      success: !!result.productName,
      userId: this.contextService.getUserId(),
    });
    await this.extractionsRepo.recordSafely({
      tenantId,
      operation: 'label-analysis',
      provider: result.provider,
      sourceType: 'text',
      success: result.productName ? 'true' : 'false',
      extractedText: truncateForStorage(
        [result.productName, result.brand, result.summary].filter(Boolean).join('\n'),
        AI_EXTRACTED_TEXT_MAX,
      ),
      extractedData: {
        productName: result.productName,
        brand: result.brand,
        category: result.category,
        ingredients: result.ingredients,
        allergens: result.allergens,
        nutritionalInfo: result.nutritionalInfo,
        healthFlags: result.healthFlags,
        summary: result.summary,
      },
      confidence: String(result.confidence),
      durationMs: result.durationMs,
      cost: String(result.cost),
      userId: this.contextService.getUserId() ?? null,
      requestId: this.contextService.getRequestId(),
      metadata: result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {},
    });
  }

  private async persistImageFallback(
    tenantId: string,
    result: ImageFallbackResult,
    mediaId: string,
  ): Promise<void> {
    await this.usageTracker.trackUsage({
      tenantId,
      operation: 'image-fallback',
      provider: result.provider,
      cost: result.cost,
      durationMs: result.durationMs,
      success: result.candidates.length > 0,
      resourceId: mediaId,
      userId: this.contextService.getUserId(),
    });
    await this.extractionsRepo.recordSafely({
      tenantId,
      operation: 'image-fallback',
      provider: result.provider,
      sourceType: 'media',
      sourceId: mediaId,
      success: result.candidates.length > 0 ? 'true' : 'false',
      extractedText: truncateForStorage(result.ocrText ?? '', AI_EXTRACTED_TEXT_MAX),
      extractedData: {
        candidates: result.candidates,
        ean: result.ean,
      },
      confidence: String(result.confidence),
      durationMs: result.durationMs,
      cost: String(result.cost),
      userId: this.contextService.getUserId() ?? null,
      requestId: this.contextService.getRequestId(),
      metadata: {},
    });
  }

  private mockOcrResult(): OcrResult {
    return {
      success: false,
      text: '',
      confidence: 0,
      provider: 'mlkit' as AiProvider,
      cost: 0,
      durationMs: 0,
      warnings: ['No OCR provider available — mobile must supply preExtractedText'],
    };
  }

  private unavailableLabel(provider: AiProvider, reason?: string): LabelAnalysisResult {
    return {
      confidence: 0,
      provider,
      cost: 0,
      durationMs: 0,
      warnings: [reason ?? `${provider} unavailable`],
    };
  }
}
