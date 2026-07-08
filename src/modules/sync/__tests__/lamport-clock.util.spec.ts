import {
  compareLamport,
  lamportWins,
  parseLamport,
  type LamportTimestamp,
} from '../utils/lamport-clock.util';

/**
 * BE-44 — Lamport clock comparator unit tests.
 *
 * Covers parsing of every wire shape Mobile_App may send (object,
 * number, "counter:nodeId" string, plain numeric string, malformed)
 * plus the deterministic compare semantics used by the bulk sync
 * orchestrator's last-write-wins rule.
 */
describe('lamport-clock.util', () => {
  describe('parseLamport', () => {
    it('returns null for null/undefined', () => {
      expect(parseLamport(null)).toBeNull();
      expect(parseLamport(undefined)).toBeNull();
    });

    it('parses a finite number into { counter, nodeId: "" }', () => {
      expect(parseLamport(42)).toEqual({ counter: 42, nodeId: '' });
    });

    it('floors fractional numbers and clamps negatives to 0', () => {
      expect(parseLamport(7.9)).toEqual({ counter: 7, nodeId: '' });
      expect(parseLamport(-5)).toEqual({ counter: 0, nodeId: '' });
    });

    it('rejects non-finite numbers', () => {
      expect(parseLamport(Number.NaN)).toBeNull();
      expect(parseLamport(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it('parses pure numeric strings', () => {
      expect(parseLamport('123')).toEqual({ counter: 123, nodeId: '' });
    });

    it('parses "counter:nodeId" composite strings', () => {
      expect(parseLamport('17:device-A')).toEqual({ counter: 17, nodeId: 'device-A' });
    });

    it('parses object form with a string nodeId', () => {
      expect(parseLamport({ counter: 5, nodeId: 'phone-1' })).toEqual({
        counter: 5,
        nodeId: 'phone-1',
      });
    });

    it('parses object form when nodeId is missing', () => {
      expect(parseLamport({ counter: 5 })).toEqual({ counter: 5, nodeId: '' });
    });

    it('returns null for malformed strings and objects', () => {
      expect(parseLamport('abc')).toBeNull();
      expect(parseLamport(':only-node')).toBeNull();
      expect(parseLamport({ counter: -1 })).toBeNull();
      expect(parseLamport({ counter: Number.NaN })).toBeNull();
    });
  });

  describe('compareLamport', () => {
    const a: LamportTimestamp = { counter: 10, nodeId: 'a' };
    const b: LamportTimestamp = { counter: 20, nodeId: 'a' };

    it('treats two nulls as equal', () => {
      expect(compareLamport(null, null)).toBe(0);
    });

    it('any real timestamp wins over null', () => {
      expect(compareLamport(null, a)).toBe(-1);
      expect(compareLamport(a, null)).toBe(1);
    });

    it('higher counter wins regardless of nodeId', () => {
      expect(compareLamport(a, b)).toBe(-1);
      expect(compareLamport(b, a)).toBe(1);
    });

    it('breaks ties on nodeId lexicographically', () => {
      const left: LamportTimestamp = { counter: 5, nodeId: 'a' };
      const right: LamportTimestamp = { counter: 5, nodeId: 'b' };
      expect(compareLamport(left, right)).toBe(-1);
      expect(compareLamport(right, left)).toBe(1);
    });

    it('returns 0 for fully equal timestamps', () => {
      expect(compareLamport({ counter: 1, nodeId: 'x' }, { counter: 1, nodeId: 'x' })).toBe(0);
    });

    it('is deterministic across hosts (same inputs, same output)', () => {
      const x: LamportTimestamp = { counter: 7, nodeId: 'phone' };
      const y: LamportTimestamp = { counter: 7, nodeId: 'tablet' };
      const first = compareLamport(x, y);
      const second = compareLamport(x, y);
      const third = compareLamport(x, y);
      expect(first).toBe(second);
      expect(second).toBe(third);
    });
  });

  describe('lamportWins', () => {
    it('returns true when incoming is newer', () => {
      const incoming: LamportTimestamp = { counter: 100, nodeId: 'a' };
      const current: LamportTimestamp = { counter: 50, nodeId: 'a' };
      expect(lamportWins(incoming, current)).toBe(true);
    });

    it('returns false when incoming is older or equal', () => {
      const ts: LamportTimestamp = { counter: 5, nodeId: 'a' };
      expect(lamportWins(ts, ts)).toBe(false);
      expect(lamportWins({ counter: 4, nodeId: 'a' }, ts)).toBe(false);
    });

    it('returns true when current is null and incoming is real', () => {
      expect(lamportWins({ counter: 1, nodeId: '' }, null)).toBe(true);
    });

    it('returns false when incoming is null', () => {
      expect(lamportWins(null, { counter: 1, nodeId: '' })).toBe(false);
      expect(lamportWins(null, null)).toBe(false);
    });
  });
});
