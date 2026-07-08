import { DEFAULT_EXPIRY_THRESHOLDS, getDefaultThreshold } from '../constants/default-thresholds';

describe('DEFAULT_EXPIRY_THRESHOLDS', () => {
  it('contains the canonical 13 categories', () => {
    expect(DEFAULT_EXPIRY_THRESHOLDS.length).toBe(13);
  });

  it('always has a falls-back-to "other" row', () => {
    expect(DEFAULT_EXPIRY_THRESHOLDS.find((t) => t.category === 'other')).toBeDefined();
  });

  it('every row has yellowDays > redDays', () => {
    for (const t of DEFAULT_EXPIRY_THRESHOLDS) {
      expect(t.yellowDays).toBeGreaterThan(t.redDays);
    }
  });
});

describe('getDefaultThreshold', () => {
  it('returns the matching row by category (lower-cased)', () => {
    expect(getDefaultThreshold('dairy').yellowDays).toBe(7);
    expect(getDefaultThreshold('DAIRY').yellowDays).toBe(7);
    expect(getDefaultThreshold('medicine').redDays).toBe(30);
  });

  it('falls back to other for unknown categories', () => {
    const fallback = getDefaultThreshold('made-up-category');
    expect(fallback.category).toBe('other');
  });

  it('falls back to other for null/undefined', () => {
    expect(getDefaultThreshold(null).category).toBe('other');
    expect(getDefaultThreshold(undefined).category).toBe('other');
  });
});
