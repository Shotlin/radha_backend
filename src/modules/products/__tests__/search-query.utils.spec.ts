import {
  QUERY_LENGTH_LIMIT,
  escapeLikePattern,
  ilikePrefix,
  ilikeSubstring,
  sanitiseQuery,
} from '../utils/search-query.utils';

describe('sanitiseQuery', () => {
  it('returns empty string for null/undefined/empty input', () => {
    expect(sanitiseQuery(null)).toBe('');
    expect(sanitiseQuery(undefined)).toBe('');
    expect(sanitiseQuery('')).toBe('');
  });

  it('strips control characters', () => {
    expect(sanitiseQuery('hello\u0000world')).toBe('hello world');
    expect(sanitiseQuery('he\u001fllo')).toBe('he llo');
  });

  it('collapses multiple whitespace into single space', () => {
    expect(sanitiseQuery('  hello   \t  world  ')).toBe('hello world');
  });

  it('trims edges', () => {
    expect(sanitiseQuery('   abc   ')).toBe('abc');
  });

  it('caps at the configured length limit', () => {
    const long = 'a'.repeat(200);
    const out = sanitiseQuery(long);
    expect(out.length).toBe(QUERY_LENGTH_LIMIT);
  });

  it('preserves Unicode characters', () => {
    expect(sanitiseQuery('चॉकलेट')).toBe('चॉकलेट');
  });
});

describe('escapeLikePattern', () => {
  it('escapes backslash, percent, and underscore', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves plain text untouched', () => {
    expect(escapeLikePattern('chocolate')).toBe('chocolate');
  });
});

describe('ilikeSubstring', () => {
  it('wraps with %', () => {
    expect(ilikeSubstring('cocoa')).toBe('%cocoa%');
  });

  it('escapes user-supplied % so it does not become a wildcard', () => {
    expect(ilikeSubstring('50%')).toBe('%50\\%%');
  });
});

describe('ilikePrefix', () => {
  it('adds trailing %', () => {
    expect(ilikePrefix('cho')).toBe('cho%');
  });

  it('escapes user-supplied %', () => {
    expect(ilikePrefix('50%')).toBe('50\\%%');
  });
});
