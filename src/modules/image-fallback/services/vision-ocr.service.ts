import { Injectable } from '@nestjs/common';

/**
 * Result of a single Cloud Vision (or self-hosted ML) OCR call.
 *
 * `costPaise` is integer paise so the running total in
 * `image_fallback_cache.vision_cost_paise` stays in cheap arithmetic.
 * Per BE-22 v2 / Req 38: Cloud Vision charges ~₹0.001/image →
 * 1 paise rounded up to keep the budget visible.
 */
export interface VisionOcrResult {
  /** OCR'd product name. */
  name: string;
  /** OCR'd brand, when separable from the name on the packaging. */
  brand?: string;
  /** Confidence in the parsed name/brand combo (0..1). */
  confidence: number;
  /** Integer paise charged for this call. */
  costPaise: number;
  /** Provider identifier — persisted to `generated_by`. */
  provider: 'google-vision' | 'mock' | 'self-hosted-ml';
}

/**
 * BE-45 — Cloud Vision OCR wrapper.
 *
 * Stub implementation — returns a deterministic `Mock Cereal /
 * Mock Brand` payload so the rest of the fallback pipeline can be
 * exercised end-to-end without burning real Vision quota or
 * requiring `@google-cloud/vision` credentials in dev.
 *
 * The real BE-22 v2 wrapper will be slotted in by `image-fallback.module`
 * as soon as it's available; consumers depend on this class so the
 * swap is a one-line module change.
 */
@Injectable()
export class VisionOcrService {
  /** ₹0.001/image → 1 paise. Surface as a constant for visibility. */
  static readonly DEFAULT_COST_PAISE = 1;

  /**
   * Recognise text on the packaging at `s3ObjectKey`.
   *
   * The stub never throws and never depends on `s3ObjectKey` content
   * beyond presence — production code will fetch the object via the
   * presigned GET URL flow (BE-13 v2) before invoking Vision.
   */
  async recognize(s3ObjectKey: string, _locale?: string): Promise<VisionOcrResult> {
    if (!s3ObjectKey || typeof s3ObjectKey !== 'string') {
      throw new Error('vision-ocr.service: s3ObjectKey is required');
    }
    return {
      name: 'Mock Cereal',
      brand: 'Mock Brand',
      confidence: 0.95,
      costPaise: VisionOcrService.DEFAULT_COST_PAISE,
      provider: 'mock',
    };
  }
}
