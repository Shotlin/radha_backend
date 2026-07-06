import { Injectable } from '@nestjs/common';

import type { OcrDateValidationResult } from '../types/expiry.types';
import {
  OCR_CONFIDENCE_WARNING_THRESHOLD,
  OCR_DATE_FUTURE_LIMIT_YEARS,
  OCR_DATE_PAST_LIMIT_YEARS,
} from '../utils/expiry-rules.utils';

interface DatePattern {
  regex: RegExp;
  format: string;
  parser: (m: RegExpMatchArray) => Date | null;
}

/**
 * BE-18 — OCR-date validator.
 *
 * Mobile_App's ML-Kit OCR returns a string + confidence score; this
 * service tries to extract a sensible date and surfaces warnings for:
 *   - dates more than 10 years in past/future,
 *   - confidence below 0.7 ("verify manually" UI),
 *   - unparseable text.
 *
 * The patterns are ordered most-specific-first so YYYY-MM-DD wins
 * before a generic DD-MM-YYYY. Indian retail labels predominantly
 * use DD/MM/YYYY or MM/YYYY, so those are explicitly supported.
 */
@Injectable()
export class OcrDateValidatorService {
  private static readonly PATTERNS: ReadonlyArray<DatePattern> = [
    {
      regex: /\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/,
      format: 'YYYY-MM-DD',
      parser: (m) => OcrDateValidatorService.makeDate(+m[1]!, +m[2]!, +m[3]!),
    },
    {
      regex: /\b(\d{2})[-/.\s](\d{2})[-/.\s](\d{4})\b/,
      format: 'DD-MM-YYYY',
      parser: (m) => OcrDateValidatorService.makeDate(+m[3]!, +m[2]!, +m[1]!),
    },
    {
      regex: /\b(\d{2})[-/.](\d{4})\b/,
      format: 'MM-YYYY',
      parser: (m) => {
        // Last day of the month (1-indexed month). Idiom:
        //   new Date(Date.UTC(year, month, 0))  → last day of `month`.
        const month = +m[1]!;
        const year = +m[2]!;
        if (month < 1 || month > 12) return null;
        if (year < 1900 || year > 2999) return null;
        return new Date(Date.UTC(year, month, 0));
      },
    },
  ];

  validate(text: string, confidence = 1): OcrDateValidationResult {
    const cleaned = (text ?? '').trim();
    if (cleaned.length === 0) {
      return { valid: false, warning: 'Empty OCR text' };
    }
    const consumedRanges: Array<[number, number]> = [];
    const overlaps = (start: number, end: number): boolean =>
      consumedRanges.some(([s, e]) => start < e && end > s);

    for (const pattern of OcrDateValidatorService.PATTERNS) {
      const re = new RegExp(
        pattern.regex.source,
        pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`,
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(cleaned)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (overlaps(start, end)) continue;
        const date = pattern.parser(match);
        consumedRanges.push([start, end]);
        if (!date || Number.isNaN(date.getTime())) continue;

        const sanity = this.sanityCheck(date);
        if (!sanity.ok) {
          return {
            valid: false,
            date,
            format: pattern.format,
            warning: sanity.reason,
          };
        }
        const lowConfidence = confidence < OCR_CONFIDENCE_WARNING_THRESHOLD;
        return {
          valid: true,
          date,
          format: pattern.format,
          warning: lowConfidence ? 'Low OCR confidence — please verify date manually' : undefined,
        };
      }
    }
    return { valid: false, warning: 'No date pattern detected' };
  }

  private sanityCheck(date: Date): { ok: boolean; reason?: string } {
    const now = new Date();
    const past = new Date(now);
    past.setUTCFullYear(now.getUTCFullYear() - OCR_DATE_PAST_LIMIT_YEARS);
    const future = new Date(now);
    future.setUTCFullYear(now.getUTCFullYear() + OCR_DATE_FUTURE_LIMIT_YEARS);
    if (date < past) {
      return {
        ok: false,
        reason: `Date is more than ${OCR_DATE_PAST_LIMIT_YEARS} years in the past`,
      };
    }
    if (date > future) {
      return {
        ok: false,
        reason: `Date is more than ${OCR_DATE_FUTURE_LIMIT_YEARS} years in the future`,
      };
    }
    return { ok: true };
  }

  /**
   * Construct a UTC-midnight date with strict validation: rejects
   * `new Date('2025-02-30')` (which JS would silently roll over).
   */
  private static makeDate(year: number, month: number, day: number): Date | null {
    if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
    if (year < 1900 || year > 2999) return null;
    if (month < 1 || month > 12) return null;
    // day === 0 means "last day of month-1" in our MM/YYYY parser.
    if (day < 0 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      day !== 0 &&
      (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day)
    ) {
      return null;
    }
    return date;
  }
}
