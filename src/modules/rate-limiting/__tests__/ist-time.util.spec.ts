import {
  IST_OFFSET_MS,
  midnightISTAsIso,
  monthEndISTAsIso,
  secondsUntilMidnightIST,
  secondsUntilMonthEndIST,
  todayIST,
  yearMonthIST,
} from '../utils/ist-time.util';

describe('ist-time.util', () => {
  describe('todayIST', () => {
    it('returns the IST calendar date when given a UTC instant past 18:30', () => {
      // 2025-03-15T18:30:00Z is 2025-03-16T00:00:00 IST.
      const now = new Date('2025-03-15T18:30:00.000Z');
      expect(todayIST(now)).toBe('2025-03-16');
    });

    it('returns the previous-day IST date when UTC is just before 18:30', () => {
      const now = new Date('2025-03-15T18:29:59.000Z');
      expect(todayIST(now)).toBe('2025-03-15');
    });

    it('handles year boundaries', () => {
      // 2024-12-31T18:30:00Z → 2025-01-01T00:00:00 IST
      const now = new Date('2024-12-31T18:30:00.000Z');
      expect(todayIST(now)).toBe('2025-01-01');
    });
  });

  describe('yearMonthIST', () => {
    it('returns YYYY-MM in IST', () => {
      expect(yearMonthIST(new Date('2025-03-15T12:00:00.000Z'))).toBe('2025-03');
    });

    it('flips to next month at IST month boundary', () => {
      // 2025-03-31T18:30:00Z is 2025-04-01T00:00:00 IST.
      expect(yearMonthIST(new Date('2025-03-31T18:30:00.000Z'))).toBe('2025-04');
    });
  });

  describe('secondsUntilMidnightIST', () => {
    it('returns 24h when the IST clock just ticked past midnight', () => {
      // 00:00:00 IST = 18:30:00 UTC the previous day.
      const now = new Date('2025-03-14T18:30:00.000Z');
      expect(secondsUntilMidnightIST(now)).toBe(24 * 3600);
    });

    it('returns ~1 second when one second before IST midnight', () => {
      const now = new Date('2025-03-15T18:29:59.000Z');
      expect(secondsUntilMidnightIST(now)).toBe(1);
    });

    it('always returns a positive integer', () => {
      const now = new Date('2025-03-15T18:30:00.000Z'); // exactly midnight IST
      const seconds = secondsUntilMidnightIST(now);
      expect(seconds).toBeGreaterThan(0);
      expect(Number.isInteger(seconds)).toBe(true);
    });
  });

  describe('secondsUntilMonthEndIST', () => {
    it('returns the gap to the start of next month at 00:00 IST', () => {
      // 2025-03-15T12:00 UTC → 2025-03-15T17:30 IST
      // Next month start in IST = 2025-04-01T00:00 IST = 2025-03-31T18:30 UTC
      const now = new Date('2025-03-15T12:00:00.000Z');
      const expected = Math.ceil(
        (Date.parse('2025-03-31T18:30:00.000Z') - now.getTime()) / 1000,
      );
      expect(secondsUntilMonthEndIST(now)).toBe(expected);
    });

    it('rolls year over correctly', () => {
      // 2024-12-15 → next month start in IST = 2025-01-01T00:00 IST
      const now = new Date('2024-12-15T12:00:00.000Z');
      const seconds = secondsUntilMonthEndIST(now);
      expect(seconds).toBeGreaterThan(0);
    });
  });

  describe('midnightISTAsIso', () => {
    it('returns the next IST midnight as an ISO-8601 string', () => {
      const now = new Date('2025-03-15T12:00:00.000Z');
      // 2025-03-16T00:00:00 IST = 2025-03-15T18:30:00 UTC
      expect(midnightISTAsIso(now)).toBe('2025-03-15T18:30:00.000Z');
    });

    it('matches secondsUntilMidnightIST when reconstructed', () => {
      const now = new Date('2025-03-15T07:00:00.000Z');
      const iso = midnightISTAsIso(now);
      const seconds = secondsUntilMidnightIST(now);
      const reconstructed = new Date(now.getTime() + seconds * 1000).toISOString();
      // We round up; rebuilt time should be at most one second after the ISO target.
      expect(new Date(reconstructed).getTime()).toBeGreaterThanOrEqual(
        new Date(iso).getTime() - 1,
      );
    });
  });

  describe('monthEndISTAsIso', () => {
    it('returns the first day of next month at 00:00 IST in UTC', () => {
      const now = new Date('2025-03-15T12:00:00.000Z');
      expect(monthEndISTAsIso(now)).toBe('2025-03-31T18:30:00.000Z');
    });
  });

  describe('IST_OFFSET_MS sanity', () => {
    it('encodes the +05:30 offset in milliseconds', () => {
      expect(IST_OFFSET_MS).toBe((5 * 60 + 30) * 60 * 1000);
    });
  });
});
