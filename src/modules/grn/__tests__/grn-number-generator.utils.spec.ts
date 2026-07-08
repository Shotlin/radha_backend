import { GrnNumberGenerator } from '../utils/grn-number-generator.utils';

describe('GrnNumberGenerator (pure helpers)', () => {
  const STORE = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';

  describe('buildPrefix', () => {
    it('uses first 6 hex chars of storeId, lowercased and de-hyphenated', () => {
      const prefix = GrnNumberGenerator.buildPrefix(STORE, new Date(Date.UTC(2026, 5, 15)));
      expect(prefix).toBe('GRN-0a1b2c-202606');
    });

    it('zero-pads the month', () => {
      const prefix = GrnNumberGenerator.buildPrefix(STORE, new Date(Date.UTC(2026, 0, 1)));
      expect(prefix).toBe('GRN-0a1b2c-202601');
    });

    it('produces a different prefix for a different month', () => {
      const a = GrnNumberGenerator.buildPrefix(STORE, new Date(Date.UTC(2026, 4, 1)));
      const b = GrnNumberGenerator.buildPrefix(STORE, new Date(Date.UTC(2026, 5, 1)));
      expect(a).not.toBe(b);
    });
  });

  describe('formatNumber', () => {
    it('zero-pads the sequence to 4 digits', () => {
      expect(GrnNumberGenerator.formatNumber('GRN-abcdef-202606', 1)).toBe(
        'GRN-abcdef-202606-0001',
      );
      expect(GrnNumberGenerator.formatNumber('GRN-abcdef-202606', 42)).toBe(
        'GRN-abcdef-202606-0042',
      );
    });

    it('rolls past 9999 cleanly without truncating', () => {
      expect(GrnNumberGenerator.formatNumber('GRN-abcdef-202606', 12345)).toBe(
        'GRN-abcdef-202606-12345',
      );
    });
  });
});

describe('GrnNumberGenerator.peekNextSequence', () => {
  // Helper that builds a stub `DbService` whose `getDb().select()...
  // .limit()` returns the rows we hand it. Lets us test the parser
  // without spinning up Postgres.
  const buildGen = (rows: Array<{ grnNumber: string }>) => {
    const limitFn = jest.fn().mockResolvedValue(rows);
    const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
    const whereFn = jest.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = jest.fn().mockReturnValue({ where: whereFn });
    const selectFn = jest.fn().mockReturnValue({ from: fromFn });
    const getDbFn = jest.fn().mockReturnValue({ select: selectFn });
    const db = { getDb: getDbFn } as unknown as ConstructorParameters<typeof GrnNumberGenerator>[0];
    return new GrnNumberGenerator(db);
  };

  it('returns 1 when no rows match the prefix', async () => {
    const gen = buildGen([]);
    const next = await gen.peekNextSequence('tenant-1', 'GRN-abc-202606');
    expect(next).toBe(1);
  });

  it('returns previous + 1 for normal sequences', async () => {
    const gen = buildGen([{ grnNumber: 'GRN-abc-202606-0042' }]);
    expect(await gen.peekNextSequence('tenant-1', 'GRN-abc-202606')).toBe(43);
  });

  it('handles 5-digit sequences (post-9999 overflow)', async () => {
    const gen = buildGen([{ grnNumber: 'GRN-abc-202606-12345' }]);
    expect(await gen.peekNextSequence('tenant-1', 'GRN-abc-202606')).toBe(12346);
  });

  it('falls back to 1 when the suffix is unparseable', async () => {
    const gen = buildGen([{ grnNumber: 'GRN-abc-202606-XXXX' }]);
    expect(await gen.peekNextSequence('tenant-1', 'GRN-abc-202606')).toBe(1);
  });
});
