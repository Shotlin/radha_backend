import { isSecretKey, maskObject, maskSecret } from '../secrets.utils';

describe('secrets.utils', () => {
  describe('isSecretKey', () => {
    it.each([
      ['DB_PASSWORD', true],
      ['TWO_FACTOR_API_KEY', true],
      ['JWT_ACCESS_SECRET', true],
      ['AWS_SECRET_ACCESS_KEY', true],
      ['AWS_ACCESS_KEY_ID', true],
      ['authorization', true],
      ['NODE_ENV', false],
      ['PORT', false],
      ['DB_HOST', false],
    ])('isSecretKey(%s) === %s', (key, expected) => {
      expect(isSecretKey(key)).toBe(expected);
    });
  });

  describe('maskSecret', () => {
    it('returns <empty> for empty values', () => {
      expect(maskSecret('')).toBe('<empty>');
    });

    it('returns <undefined> for null/undefined', () => {
      expect(maskSecret(null)).toBe('<undefined>');
      expect(maskSecret(undefined)).toBe('<undefined>');
    });

    it('fully masks short values', () => {
      expect(maskSecret('abc')).toBe('****');
      expect(maskSecret('abcd')).toBe('****');
    });

    it('shows only a hint for long values', () => {
      expect(maskSecret('abcdefghij')).toBe('abcd****ij');
    });
  });

  describe('maskObject', () => {
    it('masks nested secret-shaped keys', () => {
      const masked = maskObject({
        port: 3000,
        database: { host: 'db', password: 'super-secret-password' },
        jwt: { JWT_ACCESS_SECRET: 'aaaaaaaaaa' },
      });
      expect(masked.port).toBe(3000);
      expect((masked.database as { password: string }).password).toMatch(/\*\*\*\*/);
      expect((masked.jwt as { JWT_ACCESS_SECRET: string }).JWT_ACCESS_SECRET).toMatch(/\*\*\*\*/);
    });

    it('leaves plain values untouched', () => {
      const masked = maskObject({ region: 'ap-south-1', port: 5432 });
      expect(masked).toEqual({ region: 'ap-south-1', port: 5432 });
    });
  });
});
