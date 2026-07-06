import { Injectable } from '@nestjs/common';

import { AiOrchestratorService } from '@/integrations/ai/services/ai-orchestrator.service';
import { UsageTrackerService } from '@/integrations/ai/services/usage-tracker.service';
import type {
  AiOperation,
  DateRange,
  ImageFallbackResult,
  IngredientExplanationResult,
  LabelAnalysisResult,
  LimitCheckResult,
  LlmResult,
  OcrOptions,
  OcrResult,
  UsageStats,
} from '@/integrations/ai/types/ai.types';

/**
 * BE-22 — Module-level service that adapts orchestrator output for the
 * REST controller. Keeps the controller transport-only and gives BE-40
 * / BE-45 a thin, stable injection target if they prefer the
 * `modules/ai` surface over the integration package.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly usageTracker: UsageTrackerService,
  ) {}

  extractExpiryDate(mediaId: string, options: OcrOptions = {}): Promise<OcrResult> {
    return this.orchestrator.extractExpiryDate(mediaId, options);
  }

  extractBatchNumber(mediaId: string, options: OcrOptions = {}): Promise<OcrResult> {
    return this.orchestrator.extractBatchNumber(mediaId, options);
  }

  extractText(mediaId: string, options: OcrOptions = {}): Promise<OcrResult> {
    return this.orchestrator.extractText(mediaId, options);
  }

  analyzeProductLabel(mediaId: string): Promise<LabelAnalysisResult> {
    return this.orchestrator.analyzeProductLabel(mediaId);
  }

  analyzeLabelText(transcript: string, locale = 'en'): Promise<LabelAnalysisResult> {
    return this.orchestrator.analyzeLabelText(transcript, { locale });
  }

  imageFallbackScan(mediaId: string): Promise<ImageFallbackResult> {
    return this.orchestrator.imageFallbackScan(mediaId);
  }

  generateReportSummary(reportData: unknown): Promise<LlmResult> {
    return this.orchestrator.generateReportSummary(reportData);
  }

  explainIngredient(slug: string, locale = 'en'): Promise<IngredientExplanationResult> {
    return this.orchestrator.explainIngredient(slug, { locale });
  }

  getUsage(tenantId: string, range: DateRange): Promise<UsageStats> {
    return this.orchestrator.getUsage(tenantId, range);
  }

  checkLimit(tenantId: string, operation: AiOperation): Promise<LimitCheckResult> {
    return this.usageTracker.checkLimit(tenantId, operation);
  }
}
