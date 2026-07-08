import {
  extractDates,
  extractEans,
  extractNumbers,
  truncateForStorage,
} from '../utils/ocr-text-parser.utils';

describe('extractDates', () => {
  it('returns empty array for empty / null / non-string input', () => {
    expect(extractDates('')).toEqual([]);
    // @ts-expect-error: defensive input handling
    expect(extractDates(null)).toEqual([]);
    // @ts-expect-error: defensive input handling
    expect(extractDates(undefined)).toEqual([]);
  });

  it('parses EXP DD/MM/YYYY with prefix variants', () => {
    const out = extractDates('EXP: 31/12/2026');
    expect(out).toHaveLength(1);
    expect(out[0].format).toContain('EXP');
    expect(out[0].parsed.getUTCFullYear()).toBe(2026);
    expect(out[0].parsed.getUTCMonth()).toBe(11);
    expect(out[0].parsed.getUTCDate()).toBe(31);
    expect(out[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('parses MFG with various separators', () => {
    const a = extractDates('MFG 01-06-2024');
    const b = extractDates('MFD: 01.06.2024');
    expect(a[0].parsed.toISOString().slice(0, 10)).toBe('2024-06-01');
    expect(b[0].parsed.toISOString().slice(0, 10)).toBe('2024-06-01');
  });

  it('parses ISO YYYY-MM-DD', () => {
    const out = extractDates('Date: 2027-03-15');
    expect(out).toHaveLength(1);
    expect(out[0].format).toBe('YYYY-MM-DD');
    expect(out[0].parsed.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('parses MM/YYYY rolling to last day of month including leap years', () => {
    const a = extractDates('Best before 02/2024'); // Feb 2024 leap year
    expect(a[0].parsed.toISOString().slice(0, 10)).toBe('2024-02-29');

    const b = extractDates('Best before 02/2025'); // Feb 2025 non-leap
    expect(b[0].parsed.toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('rejects calendar-invalid dates like Feb 30', () => {
    const out = extractDates('EXP 30/02/2025');
    expect(out).toEqual([]);
  });

  it('rejects month 13', () => {
    const out = extractDates('EXP 01/13/2025');
    expect(out).toEqual([]);
  });

  it('rejects implausible years', () => {
    const out = extractDates('EXP 01/01/3500');
    expect(out).toEqual([]);
  });

  it('normalises 2-digit years using a 50-year pivot', () => {
    const future = extractDates('EXP 31/12/26');
    const past = extractDates('MFG 01/01/95');
    expect(future[0].parsed.getUTCFullYear()).toBe(2026);
    expect(past[0].parsed.getUTCFullYear()).toBe(1995);
  });

  it('returns dates sorted chronologically and deduped', () => {
    // The same string matches both "DD/MM/YYYY" and "EXP DD/MM/YYYY"
    // patterns — we expect the more specific one + the generic one
    // distinct, but identical (format, time) pairs deduped.
    const out = extractDates('EXP 31/12/2026 and 01/01/2025');
    const times = out.map((d) => d.parsed.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('multiple distinct dates surface independently', () => {
    const out = extractDates('MFG 01/01/2024  EXP 31/12/2026');
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
});

describe('extractNumbers', () => {
  it('returns empty array for empty input', () => {
    expect(extractNumbers('')).toEqual([]);
  });

  it('extracts bare digit runs by default', () => {
    expect(extractNumbers('Lot 4567 and 1234567')).toEqual(['4567', '1234567']);
  });

  it('honours custom regex', () => {
    expect(extractNumbers('Batch ABC1234 X1234567', /\b[A-Z]{1,3}\d{4,8}\b/)).toEqual([
      'ABC1234',
      'X1234567',
    ]);
  });

  it('dedupes repeated numbers', () => {
    expect(extractNumbers('1234 1234 5678')).toEqual(['1234', '5678']);
  });
});

describe('extractEans', () => {
  it('extracts EAN-13 sequences', () => {
    expect(extractEans('Code 3017620422003 found')).toEqual(['3017620422003']);
  });

  it('extracts EAN-8 sequences', () => {
    expect(extractEans('Short code 12345678')).toEqual(['12345678']);
  });

  it('rejects 9–12 digit garbage that is neither EAN-8 nor EAN-13', () => {
    expect(extractEans('1234567890')).toEqual([]);
  });

  it('handles empty / null gracefully', () => {
    expect(extractEans('')).toEqual([]);
    // @ts-expect-error: defensive input handling
    expect(extractEans(null)).toEqual([]);
  });
});

describe('truncateForStorage', () => {
  it('returns text unchanged when within limit', () => {
    expect(truncateForStorage('hello', 100)).toBe('hello');
  });

  it('appends ellipsis when over limit', () => {
    const out = truncateForStorage('a'.repeat(50), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('...')).toBe(true);
  });

  it('handles empty input', () => {
    expect(truncateForStorage('', 10)).toBe('');
  });
});
