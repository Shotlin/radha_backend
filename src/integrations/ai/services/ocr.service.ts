import { Injectable } from '@nestjs/common';

import { extractDates, extractEans, extractNumbers } from '../utils/ocr-text-parser.utils';
import type { ExtractedDate, IOcrParser, OcrOptions, OcrResult } from '../types/ai.types';

/**
 * BE-22 — Provider-agnostic OCR parser.
 *
 * Server-side OCR for RADHA is intentionally minimal: we expect the
 * mobile app to do the heavy lifting on-device with Google ML Kit.
 * This service:
 *
 *   1. Wraps mobile-supplied text (`options.preExtractedText`) into
 *      the shared `OcrResult` envelope so callers can be agnostic
 *      about whether the extraction happened on-device or server-side.
 *   2. Exposes the pure parsing helpers (`extractDates`,
 *      `extractNumbers`, `extractEans`) as Nest-injectable methods so
 *      the orchestrator can call them through a consistent surface.
 *
 * Real cloud OCR (AWS Rekognition, Google Cloud Vision) lives in the
 * provider classes; this service is the parser, not the network call.
 */
@Injectable()
export class OcrService implements IOcrParser {
  /** Wrap mobile-supplied text into an `OcrResult`. */
  fromPreExtracted(options: OcrOptions): OcrResult {
    const text = options.preExtractedText ?? '';
    const confidence = options.preExtractedConfidence ?? 0.8;
    return {
      success: text.length > 0,
      text,
      confidence,
      provider: 'mlkit',
      cost: 0,
      durationMs: 0,
    };
  }

  extractDates(text: string): ExtractedDate[] {
    return extractDates(text);
  }

  extractNumbers(text: string, pattern?: RegExp): string[] {
    return extractNumbers(text, pattern);
  }

  extractEans(text: string): string[] {
    return extractEans(text);
  }
}
