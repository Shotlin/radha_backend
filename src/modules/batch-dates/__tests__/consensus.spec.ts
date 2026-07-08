import {
  BatchDateObservationInput,
  computeConsensus,
  normalizeBatchCode,
} from '../consensus';

/**
 * BE-58 — `consensus.ts` unit tests. Pure functions, synthetic
 * observations only — no DB, no Nest. Mirrors the app-side discipline of
 * unit-testing frame_consensus_aggregator.dart standalone.
 */
describe('normalizeBatchCode', () => {
  it('uppercases and strips non-alphanumerics', () => {
    expect(normalizeBatchCode('B.No: L-2043/A')).toBe('BNOL2043A');
  });

  it('is idempotent on an already-normalized code', () => {
    expect(normalizeBatchCode('BC2201')).toBe('BC2201');
  });

  it('treats equivalent noisy inputs as the same code', () => {
    expect(normalizeBatchCode('l 2043 a')).toBe(normalizeBatchCode('L-2043-A'));
  });
});

describe('computeConsensus', () => {
  const day = (offset: number): Date => {
    const base = new Date('2026-08-15T00:00:00.000Z');
    base.setUTCDate(base.getUTCDate() + offset);
    return base;
  };

  const obs = (
    userId: string,
    expiryOffset: number,
    overrides: Partial<BatchDateObservationInput> = {},
  ): BatchDateObservationInput => ({
    userId,
    expiryDate: day(expiryOffset),
    mfgDate: null,
    source: 'user_scan',
    extractorConfidence: 0.9,
    ...overrides,
  });

  it('throws on an empty observation list (callers must never call this with nothing)', () => {
    expect(() => computeConsensus([])).toThrow();
  });

  describe('trusted: >=3 distinct users agreeing', () => {
    it('confirms with 3 distinct users on the same date', () => {
      const result = computeConsensus([obs('u1', 0), obs('u2', 0), obs('u3', 0)]);
      expect(result.status).toBe('trusted');
      expect(result.consensusExpiry).toEqual(day(0));
      expect(result.distinctUsers).toBe(3);
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('pools dates within +-1 day into the same cluster', () => {
      const result = computeConsensus([obs('u1', 0), obs('u2', 1), obs('u3', -1)]);
      expect(result.status).toBe('trusted');
      expect(result.distinctUsers).toBe(3);
    });

    it('confidence is floored at 0.5 even with a small minority overall', () => {
      // 3 users agree, but there are 10 total distinct users across all
      // clusters -- the raw ratio (3/10=0.3) would undersell a genuinely
      // trusted cluster, so the floor kicks in.
      const others = Array.from({ length: 7 }, (_, i) => obs(`stray${i}`, 30 + i));
      const result = computeConsensus([obs('u1', 0), obs('u2', 0), obs('u3', 0), ...others]);
      expect(result.status).toBe('trusted');
      expect(result.confidence).toBe(0.5);
    });

    it('backfill-only observations can NEVER reach trusted alone', () => {
      const result = computeConsensus([
        obs('u1', 0, { source: 'backfill_scan_items' }),
        obs('u2', 0, { source: 'backfill_expiry_records' }),
        obs('u3', 0, { source: 'backfill_scan_items' }),
      ]);
      expect(result.status).toBe('candidate');
    });

    it('one real observation joining a backfill majority unlocks trusted', () => {
      const result = computeConsensus([
        obs('u1', 0, { source: 'backfill_scan_items' }),
        obs('u2', 0, { source: 'backfill_expiry_records' }),
        obs('u3', 0, { source: 'user_scan' }),
      ]);
      expect(result.status).toBe('trusted');
    });

    it('mfg date is the modal mfg within the winning cluster', () => {
      const mfg = day(-90);
      const result = computeConsensus([
        obs('u1', 0, { mfgDate: mfg }),
        obs('u2', 0, { mfgDate: mfg }),
        obs('u3', 0, { mfgDate: null }),
      ]);
      expect(result.consensusMfg).toEqual(mfg);
    });
  });

  describe('candidate: 1-2 distinct users', () => {
    it('two distinct users agreeing is candidate, not trusted', () => {
      const result = computeConsensus([obs('u1', 0), obs('u2', 0)]);
      expect(result.status).toBe('candidate');
      expect(result.distinctUsers).toBe(2);
    });

    it('a single high-confidence observation qualifies as candidate', () => {
      const result = computeConsensus([obs('u1', 0, { extractorConfidence: 0.95 })]);
      expect(result.status).toBe('candidate');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('a single manual observation qualifies regardless of confidence', () => {
      const result = computeConsensus([
        obs('u1', 0, { source: 'manual', extractorConfidence: null }),
      ]);
      expect(result.status).toBe('candidate');
    });

    it('a single low-confidence non-manual observation still reports candidate, honestly low confidence', () => {
      const result = computeConsensus([obs('u1', 0, { extractorConfidence: 0.4 })]);
      expect(result.status).toBe('candidate');
      expect(result.confidence).toBeLessThan(0.9);
    });
  });

  describe('disputed: two credible, disagreeing clusters', () => {
    it('two clusters of >=2 distinct users each, >2 days apart, is disputed', () => {
      const result = computeConsensus([
        obs('u1', 0),
        obs('u2', 0),
        obs('u3', 10),
        obs('u4', 10),
      ]);
      expect(result.status).toBe('disputed');
      expect(result.consensusExpiry).toBeNull();
      expect(result.suggestions).toHaveLength(2);
    });

    it('two clusters within 2 days of each other are NOT disputed (they are just noisy, not conflicting)', () => {
      // Both clusters must be more than 2 days apart per spec -- inside
      // that window the top cluster just wins normally.
      const result = computeConsensus([
        obs('u1', 0),
        obs('u2', 0),
        obs('u3', 2),
        obs('u4', 2),
      ]);
      expect(result.status).not.toBe('disputed');
    });

    it('a lone dissenting user does not trigger disputed (needs >=2 distinct users on both sides)', () => {
      const result = computeConsensus([
        obs('u1', 0),
        obs('u2', 0),
        obs('u3', 0),
        obs('u4', 30),
      ]);
      expect(result.status).toBe('trusted');
    });
  });
});
