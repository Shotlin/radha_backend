import {
  generateReferralCode,
  isWellFormedReferralCode,
  normaliseReferralCode,
  REFERRAL_CODE_LENGTH,
} from '../utils/referral-code.util';

describe('referral-code.util', () => {
  describe('generateReferralCode', () => {
    it('produces an 8-character code', () => {
      const code = generateReferralCode();
      expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
      expect(code).toHaveLength(8);
    });

    it('uses only uppercase alphanumeric characters from the safe alphabet', () => {
      for (let i = 0; i < 50; i += 1) {
        const code = generateReferralCode();
        expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
      }
    });

    it('produces highly unique codes across many invocations', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i += 1) {
        seen.add(generateReferralCode());
      }
      // 30^8 keyspace — collisions inside 1k samples are vanishingly rare.
      expect(seen.size).toBe(1000);
    });
  });

  describe('normaliseReferralCode', () => {
    it('uppercases and trims whitespace', () => {
      expect(normaliseReferralCode(' abc23xyz ')).toBe('ABC23XYZ');
    });

    it('leaves already-canonical input unchanged', () => {
      expect(normaliseReferralCode('ABCD2345')).toBe('ABCD2345');
    });
  });

  describe('isWellFormedReferralCode', () => {
    it('accepts canonical 8-char A-Z/0-9 codes', () => {
      expect(isWellFormedReferralCode('ABCD2345')).toBe(true);
      expect(isWellFormedReferralCode('99999999')).toBe(true);
    });

    it('rejects wrong length', () => {
      expect(isWellFormedReferralCode('ABC')).toBe(false);
      expect(isWellFormedReferralCode('ABCDEFGHIJ')).toBe(false);
    });

    it('rejects lowercase / symbols', () => {
      expect(isWellFormedReferralCode('abcd2345')).toBe(false);
      expect(isWellFormedReferralCode('ABCD-345')).toBe(false);
      expect(isWellFormedReferralCode('ABCD 345')).toBe(false);
    });
  });
});
