import { computeNextRunAt, estimateDurationSeconds } from '../utils/schedule.utils';

describe('computeNextRunAt', () => {
  it('rolls daily schedule forward to today when target hour is in the future', () => {
    const ref = new Date('2026-04-10T01:00:00Z');
    const next = computeNextRunAt({ frequency: 'daily', hourOfDay: 5 }, ref);
    expect(next.toISOString()).toBe('2026-04-10T05:00:00.000Z');
  });

  it('rolls daily schedule to tomorrow when target hour has already passed today', () => {
    const ref = new Date('2026-04-10T07:30:00Z');
    const next = computeNextRunAt({ frequency: 'daily', hourOfDay: 5 }, ref);
    expect(next.toISOString()).toBe('2026-04-11T05:00:00.000Z');
  });

  it('handles weekly schedule on a future weekday', () => {
    // 2026-04-10 is a Friday (UTC). Target dayOfWeek=2 (Tuesday).
    const ref = new Date('2026-04-10T05:00:00Z');
    const next = computeNextRunAt({ frequency: 'weekly', hourOfDay: 9, dayOfWeek: 2 }, ref);
    expect(next.getUTCDay()).toBe(2);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getTime()).toBeGreaterThan(ref.getTime());
  });

  it('rolls weekly schedule to next week when same-day hour has passed', () => {
    // Friday 5 Apr 2026 09:00 UTC (Friday, dow=5). Target dayOfWeek=5 hour=8.
    const ref = new Date('2026-04-10T09:00:00Z');
    const next = computeNextRunAt({ frequency: 'weekly', hourOfDay: 8, dayOfWeek: 5 }, ref);
    expect(next.getTime() - ref.getTime()).toBeGreaterThanOrEqual(6 * 24 * 60 * 60 * 1000);
    expect(next.getUTCDay()).toBe(5);
  });

  it('rolls monthly schedule to next month when target day has passed', () => {
    const ref = new Date('2026-04-15T12:00:00Z');
    const next = computeNextRunAt({ frequency: 'monthly', hourOfDay: 1, dayOfMonth: 5 }, ref);
    expect(next.getUTCMonth()).toBe(4); // May (0-indexed)
    expect(next.getUTCDate()).toBe(5);
  });

  it('clamps invalid dayOfMonth to within 1..28', () => {
    const ref = new Date('2026-04-01T00:00:00Z');
    const next = computeNextRunAt({ frequency: 'monthly', hourOfDay: 2, dayOfMonth: 99 }, ref);
    expect(next.getUTCDate()).toBe(28);
  });

  it('throws on unknown frequency', () => {
    expect(() =>
      computeNextRunAt({ frequency: 'yearly' as unknown as 'daily', hourOfDay: 0 }, new Date()),
    ).toThrow();
  });
});

describe('estimateDurationSeconds', () => {
  const now = Date.UTC(2026, 3, 1);

  it('returns the floor of 5 seconds for tiny windows', () => {
    expect(estimateDurationSeconds(now, now + 1000, 1)).toBe(5);
  });

  it('grows with both date range and format count', () => {
    const oneDayOneFormat = estimateDurationSeconds(now, now + 24 * 60 * 60 * 1000, 1);
    const ninetyDaysFiveFormats = estimateDurationSeconds(now, now + 90 * 24 * 60 * 60 * 1000, 5);
    expect(ninetyDaysFiveFormats).toBeGreaterThan(oneDayOneFormat);
  });

  it('caps at 300 seconds', () => {
    const huge = estimateDurationSeconds(now, now + 365 * 24 * 60 * 60 * 1000, 4);
    expect(huge).toBeLessThanOrEqual(300);
  });
});
