import type { ExtractedDate } from '../types/ai.types';

/**
 * BE-22 — Pure helpers for parsing OCR text into structured fields.
 *
 * All functions are stateless and side-effect free so they're safe to
 * call from both the API process and worker process. The expiry-domain
 * date validator (BE-18 `OcrDateValidatorService`) calibrates more
 * strictly against pharmacy / FSSAI advisories — these helpers are the
 * generic, lower-bar pass.
 *
 * Confidence values are calibrated empirically against ML Kit output on
 * Indian retail packaging samples and intentionally lower than 1.0 —
 * even a perfect regex match doesn't tell you the bytes were OCR'd
 * correctly.
 */

const TWO_DIGIT_YEAR_PIVOT = 50;
const MIN_PLAUSIBLE_YEAR = 1990;
const MAX_PLAUSIBLE_YEAR = 2100;

interface DatePattern {
  regex: RegExp;
  format: string;
  parse: (m: RegExpMatchArray) => Date | null;
  confidence: number;
}

const normaliseYear = (raw: number): number => {
  if (raw >= 100) return raw;
  return raw <= TWO_DIGIT_YEAR_PIVOT ? 2000 + raw : 1900 + raw;
};

const isCalendarValid = (y: number, m: number, d: number): boolean => {
  if (y < MIN_PLAUSIBLE_YEAR || y > MAX_PLAUSIBLE_YEAR) return false;
  if (m < 0 || m > 11) return false;
  if (d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m && date.getUTCDate() === d;
};

/**
 * Date patterns ordered most-specific first. Each pattern's
 * `parse` callback returns `null` when the captured groups don't
 * round-trip through the calendar check, so callers can drop
 * Feb 30, month 13, etc.
 */
const DATE_PATTERNS: DatePattern[] = [
  {
    regex:
      /\b(?:EXP|EXPIRY|BEST\s*BEFORE|USE\s*BY)[\s:.-]*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/gi,
    format: 'EXP DD/MM/YYYY',
    confidence: 0.92,
    parse: (m) => {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const year = normaliseYear(parseInt(m[3], 10));
      return isCalendarValid(year, month, day) ? new Date(Date.UTC(year, month, day)) : null;
    },
  },
  {
    regex: /\b(?:MFG|MFD|MANUFACTURED|PROD)[\s:.-]*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/gi,
    format: 'MFG DD/MM/YYYY',
    confidence: 0.9,
    parse: (m) => {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const year = normaliseYear(parseInt(m[3], 10));
      return isCalendarValid(year, month, day) ? new Date(Date.UTC(year, month, day)) : null;
    },
  },
  {
    regex: /\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/g,
    format: 'YYYY-MM-DD',
    confidence: 0.88,
    parse: (m) => {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const day = parseInt(m[3], 10);
      return isCalendarValid(year, month, day) ? new Date(Date.UTC(year, month, day)) : null;
    },
  },
  {
    regex: /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g,
    format: 'DD/MM/YYYY',
    confidence: 0.82,
    parse: (m) => {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const year = normaliseYear(parseInt(m[3], 10));
      return isCalendarValid(year, month, day) ? new Date(Date.UTC(year, month, day)) : null;
    },
  },
  {
    regex: /\b(\d{1,2})[\/\-.](\d{2,4})\b/g,
    format: 'MM/YYYY',
    confidence: 0.7,
    parse: (m) => {
      const month = parseInt(m[1], 10) - 1;
      const year = normaliseYear(parseInt(m[2], 10));
      // Last day of month — typical convention for "best before MM/YYYY".
      if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
      if (month < 0 || month > 11) return null;
      const last = new Date(Date.UTC(year, month + 1, 0));
      return last;
    },
  },
];

/**
 * Find every plausible date in `text`.
 *
 * Returns chronological order, deduped by `(format, parsed.getTime())`.
 */
export const extractDates = (text: string): ExtractedDate[] => {
  if (!text || typeof text !== 'string') return [];
  const out: ExtractedDate[] = [];
  const seen = new Set<string>();
  // Track character ranges already consumed by an earlier (more specific)
  // pattern so generic patterns don't re-fire over the same substring.
  const consumedRanges: Array<[number, number]> = [];
  const overlaps = (start: number, end: number): boolean =>
    consumedRanges.some(([s, e]) => start < e && end > s);

  for (const pattern of DATE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      const parsed = pattern.parse(match);
      // Mark range as consumed regardless of parse outcome so a failed
      // specific-prefix match still suppresses generic re-matches.
      consumedRanges.push([start, end]);
      if (!parsed) continue;
      const key = `${pattern.format}|${parsed.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        raw: match[0],
        parsed,
        format: pattern.format,
        confidence: pattern.confidence,
      });
    }
  }

  return out.sort((a, b) => a.parsed.getTime() - b.parsed.getTime());
};

/**
 * Pull arbitrary numbers out of OCR text.
 *
 * Defaults to bare digit runs; pass a custom pattern (e.g. batch-code
 * regex) when needed. Returned in document order, deduped.
 */
export const extractNumbers = (text: string, pattern?: RegExp): string[] => {
  if (!text || typeof text !== 'string') return [];
  const re = pattern ?? /\b\d{2,}\b/g;
  // Always make a fresh regex so we don't mutate caller-supplied state.
  const re2 = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re2.exec(text)) !== null) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
  }
  return out;
};

/**
 * Extract candidate EAN-8 / EAN-13 sequences from OCR text.
 *
 * No checksum validation here (the BE-10 product service does that on
 * lookup). We just yank plausible digit runs so the BE-45 image
 * fallback can probe the catalog without parsing the same string twice.
 */
export const extractEans = (text: string): string[] => {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/\b\d{8}(?:\d{5})?\b/g);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (m.length !== 8 && m.length !== 13) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
};

/** Truncate a candidate string to the column-safe size for `extracted_text`. */
export const truncateForStorage = (text: string, max: number): string => {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
};
