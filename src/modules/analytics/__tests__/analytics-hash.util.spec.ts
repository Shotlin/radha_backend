import {
  AnalyticsSaltMissingError,
  MIN_SALT_LENGTH,
  assertValidSalt,
  sha256WithSalt,
} from '../utils/analytics-hash.util';

describe('analytics-hash.util', () => {
  const validSalt = 'a'.repeat(MIN_SALT_LENGTH);

  describe('assertValidSalt', () => {
    it('returns the salt when it is at least 32 chars', () => {
      expect(assertValidSalt(validSalt)).toBe(validSalt);
    });

    it('throws AnalyticsSaltMissingError when salt is undefined', () => {
      expect(() => assertValidSalt(undefined)).toThrow(AnalyticsSaltMissingError);
    });

    it('throws when salt is too short', () => {
      expect(() => assertValidSalt('short')).toThrow(AnalyticsSaltMissingError);
    });

    it('throws when salt is empty', () => {
      expect(() => assertValidSalt('')).toThrow(AnalyticsSaltMissingError);
    });
  });

  describe('sha256WithSalt — visitor hashing', () => {
    it('produces the same hash for the same input + salt (de-duplication works)', () => {
      const a = sha256WithSalt('cookie-abc', validSalt);
      const b = sha256WithSalt('cookie-abc', validSalt);
      expect(a).toBe(b);
    });

    it('produces different hashes for different inputs', () => {
      const a = sha256WithSalt('cookie-abc', validSalt);
      const b = sha256WithSalt('cookie-xyz', validSalt);
      expect(a).not.toBe(b);
    });

    it('produces different hashes when salt rotates', () => {
      const a = sha256WithSalt('cookie-abc', validSalt);
      const b = sha256WithSalt('cookie-abc', 'b'.repeat(MIN_SALT_LENGTH));
      expect(a).not.toBe(b);
    });

    it('returns a 64-char hex string (SHA-256)', () => {
      const hash = sha256WithSalt('anything', validSalt);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('throws if salt is missing — fails loud rather than writing weak hashes', () => {
      expect(() => sha256WithSalt('cookie', '')).toThrow(AnalyticsSaltMissingError);
    });
  });
});
