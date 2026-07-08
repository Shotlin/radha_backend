import {
  calculateNextDueDate,
  hasRemainingOccurrences,
  isRecurrencePattern,
} from '../utils/recurrence.utils';
import type { RecurrencePattern } from '../types/task.types';

const dateOf = (iso: string) => new Date(iso);

describe('isRecurrencePattern', () => {
  it('accepts a well-formed pattern', () => {
    expect(isRecurrencePattern({ type: 'daily', interval: 1 })).toBe(true);
    expect(isRecurrencePattern({ type: 'weekly', interval: 2, daysOfWeek: [1, 3] })).toBe(true);
    expect(isRecurrencePattern({ type: 'monthly', interval: 1, dayOfMonth: 15 })).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isRecurrencePattern(null)).toBe(false);
    expect(isRecurrencePattern(undefined)).toBe(false);
    expect(isRecurrencePattern({})).toBe(false);
    expect(isRecurrencePattern({ type: 'yearly', interval: 1 })).toBe(false);
    expect(isRecurrencePattern({ type: 'daily', interval: 0 })).toBe(false);
  });
});

describe('calculateNextDueDate', () => {
  it('daily: adds interval days', () => {
    const next = calculateNextDueDate(dateOf('2026-06-01T10:00:00Z'), {
      type: 'daily',
      interval: 1,
    });
    expect(next?.toISOString()).toBe('2026-06-02T10:00:00.000Z');
  });

  it('daily: respects interval > 1', () => {
    const next = calculateNextDueDate(dateOf('2026-06-01T10:00:00Z'), {
      type: 'daily',
      interval: 3,
    });
    expect(next?.toISOString()).toBe('2026-06-04T10:00:00.000Z');
  });

  it('weekly without daysOfWeek: adds interval × 7 days', () => {
    const next = calculateNextDueDate(
      dateOf('2026-06-01T10:00:00Z'), // Monday
      { type: 'weekly', interval: 1 },
    );
    expect(next?.toISOString()).toBe('2026-06-08T10:00:00.000Z');
  });

  it('weekly with daysOfWeek: jumps to next matching day in same week', () => {
    // 2026-06-01 is Monday (DOW=1). Next Wednesday (DOW=3) is 2026-06-03.
    const next = calculateNextDueDate(dateOf('2026-06-01T10:00:00Z'), {
      type: 'weekly',
      interval: 1,
      daysOfWeek: [3, 5],
    });
    expect(next?.toISOString()).toBe('2026-06-03T10:00:00.000Z');
  });

  it('weekly with daysOfWeek: wraps to next interval-week', () => {
    // 2026-06-05 is Friday (DOW=5). With days [1] (Monday) interval=1,
    // next Monday is 2026-06-08 (3 days later).
    const next = calculateNextDueDate(dateOf('2026-06-05T10:00:00Z'), {
      type: 'weekly',
      interval: 1,
      daysOfWeek: [1],
    });
    expect(next?.getUTCDay()).toBe(1);
    expect(next?.getUTCDate()).toBe(8);
  });

  it('monthly: adds interval months and clamps day-of-month', () => {
    // Jan 31 + 1 month → Feb 28 (or 29 in leap year). 2027 is not leap.
    const next = calculateNextDueDate(dateOf('2027-01-31T10:00:00Z'), {
      type: 'monthly',
      interval: 1,
    });
    expect(next?.getUTCFullYear()).toBe(2027);
    expect(next?.getUTCMonth()).toBe(1); // Feb
    expect(next?.getUTCDate()).toBe(28);
  });

  it('monthly: dayOfMonth override takes precedence', () => {
    const next = calculateNextDueDate(dateOf('2026-06-15T10:00:00Z'), {
      type: 'monthly',
      interval: 1,
      dayOfMonth: 1,
    });
    expect(next?.getUTCMonth()).toBe(6); // July (0-indexed)
    expect(next?.getUTCDate()).toBe(1);
  });

  it('returns null when endDate is exceeded', () => {
    const next = calculateNextDueDate(dateOf('2026-06-01T10:00:00Z'), {
      type: 'daily',
      interval: 5,
      endDate: dateOf('2026-06-03T00:00:00Z'),
    });
    expect(next).toBeNull();
  });

  it('returns null for unknown frequency', () => {
    const next = calculateNextDueDate(dateOf('2026-06-01T10:00:00Z'), {
      type: 'fortnight' as RecurrencePattern['type'],
      interval: 1,
    });
    expect(next).toBeNull();
  });
});

describe('hasRemainingOccurrences', () => {
  it('returns true when occurrences not capped', () => {
    expect(hasRemainingOccurrences({ type: 'daily', interval: 1 }, 100)).toBe(true);
  });

  it('returns true when used < cap', () => {
    expect(hasRemainingOccurrences({ type: 'daily', interval: 1, occurrences: 5 }, 3)).toBe(true);
  });

  it('returns false when used >= cap', () => {
    expect(hasRemainingOccurrences({ type: 'daily', interval: 1, occurrences: 5 }, 5)).toBe(false);
    expect(hasRemainingOccurrences({ type: 'daily', interval: 1, occurrences: 5 }, 6)).toBe(false);
  });
});
