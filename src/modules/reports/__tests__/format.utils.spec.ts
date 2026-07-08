import {
  formatCellValue,
  humaniseHeader,
  inferHeaders,
  sanitizeFormula,
  slugifyForFilename,
} from '../utils/format.utils';

describe('humaniseHeader', () => {
  it('splits camelCase identifiers', () => {
    expect(humaniseHeader('redCount')).toBe('Red Count');
    expect(humaniseHeader('totalScans')).toBe('Total Scans');
  });

  it('splits snake_case and kebab-case', () => {
    expect(humaniseHeader('store_name')).toBe('Store Name');
    expect(humaniseHeader('store-name')).toBe('Store Name');
  });

  it('preserves SCREAMING_SNAKE words and replaces separators with spaces', () => {
    // Already uppercase, so the word-boundary upper-case pass is a no-op.
    expect(humaniseHeader('STORE_NAME')).toBe('STORE NAME');
  });

  it('returns empty string for empty input', () => {
    expect(humaniseHeader('')).toBe('');
  });

  it('preserves single-word headers', () => {
    expect(humaniseHeader('Status')).toBe('Status');
  });
});

describe('formatCellValue', () => {
  it('renders primitives consistently', () => {
    expect(formatCellValue(null)).toBe('');
    expect(formatCellValue(undefined)).toBe('');
    expect(formatCellValue(42)).toBe('42');
    expect(formatCellValue(true)).toBe('true');
    expect(formatCellValue('hello')).toBe('hello');
  });

  it('serialises Date objects as ISO 8601', () => {
    const d = new Date('2026-06-01T00:00:00Z');
    expect(formatCellValue(d)).toBe('2026-06-01T00:00:00.000Z');
  });

  it('JSON-stringifies object values', () => {
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');
    expect(formatCellValue([1, 2, 3])).toBe('[1,2,3]');
  });

  it('falls back to String() when JSON.stringify throws', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj; // cyclic
    expect(typeof formatCellValue(obj)).toBe('string');
  });

  it('renders bigints', () => {
    expect(formatCellValue(BigInt(42))).toBe('42');
  });
});

describe('sanitizeFormula', () => {
  it('prefixes formula triggers with an apostrophe', () => {
    expect(sanitizeFormula('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(sanitizeFormula('+1+2')).toBe("'+1+2");
    expect(sanitizeFormula('-cmd')).toBe("'-cmd");
    expect(sanitizeFormula('@webservice')).toBe("'@webservice");
    expect(sanitizeFormula('\tinjected')).toBe("'\tinjected");
    expect(sanitizeFormula('\rinjected')).toBe("'\rinjected");
  });

  it('leaves benign strings alone', () => {
    expect(sanitizeFormula('Hello world')).toBe('Hello world');
    expect(sanitizeFormula('123 abc')).toBe('123 abc');
    expect(sanitizeFormula('')).toBe('');
  });

  it('passes non-string input through', () => {
    expect(sanitizeFormula(undefined as unknown as string)).toBe(undefined);
    expect(sanitizeFormula(42 as unknown as string)).toBe(42 as unknown as string);
  });
});

describe('inferHeaders', () => {
  it('uses the first non-empty row', () => {
    expect(inferHeaders([{ a: 1, b: 2 }])).toEqual(['a', 'b']);
  });

  it('skips empty rows at the head', () => {
    expect(inferHeaders([{}, { x: 1, y: 2 }])).toEqual(['x', 'y']);
  });

  it('returns empty array when no row has keys', () => {
    expect(inferHeaders([])).toEqual([]);
    expect(inferHeaders([{}])).toEqual([]);
  });

  it('preserves insertion order', () => {
    const row = { z: 1, a: 2, m: 3 };
    expect(inferHeaders([row])).toEqual(['z', 'a', 'm']);
  });
});

describe('slugifyForFilename', () => {
  it('slugs spaces and punctuation', () => {
    expect(slugifyForFilename('Expiry — Q1 / 2026')).toBe('expiry-q1-2026');
  });

  it('normalises unicode diacritics', () => {
    expect(slugifyForFilename('Café — naïve')).toBe('cafe-naive');
  });

  it('truncates to maxLength', () => {
    expect(slugifyForFilename('a'.repeat(200), 10)).toHaveLength(10);
  });

  it('falls back to "report" when input slugs to empty', () => {
    expect(slugifyForFilename('—!!!')).toBe('report');
  });
});
