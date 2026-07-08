import { ValidationException } from '@/common/errors/business.exception';

import { PasswordService } from '../services/password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  describe('validatePolicy', () => {
    it('approves a strong password', () => {
      const result = svc.validatePolicy('Str0ng!CorrectHorseBattery');
      expect(result.valid).toBe(true);
      expect(['strong', 'very-strong']).toContain(result.strength);
      expect(result.score).toBeGreaterThanOrEqual(60);
    });

    it.each([
      ['short', 'too short'],
      ['nouppercase1!extra', 'no uppercase'],
      ['NOLOWERCASE1!EXTRA', 'no lowercase'],
      ['NoNumbersInside!!!!', 'no digit'],
      ['NoSpecialChars1234567', 'no special'],
      ['Password!@#1', 'too common (case-folded match)'],
    ])('rejects a weak password (%s — %s)', (pwd) => {
      const result = svc.validatePolicy(pwd);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('marks score 0–100', () => {
      for (const pwd of ['short', 'Str0ng!CorrectHorseBattery']) {
        const r = svc.validatePolicy(pwd);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('enforcePolicy', () => {
    it('throws ValidationException with details on weak input', () => {
      expect(() => svc.enforcePolicy('weak')).toThrow(ValidationException);
    });

    it('does not throw on a strong input', () => {
      expect(() => svc.enforcePolicy('Str0ng!CorrectHorseBattery')).not.toThrow();
    });
  });

  describe('hash + verify', () => {
    it('round-trips a password', async () => {
      const hash = await svc.hash('Str0ng!Pass-Phrase');
      expect(await svc.verify('Str0ng!Pass-Phrase', hash)).toBe(true);
      expect(await svc.verify('wrong', hash)).toBe(false);
    });
  });
});
