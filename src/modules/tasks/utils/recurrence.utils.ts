import type { RecurrenceFrequency, RecurrencePattern } from '../types/task.types';

/**
 * BE-19 — Pure helpers for recurring tasks.
 *
 * Kept side-effect-free so unit tests can hammer them without a Nest
 * test bed.
 */

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Type guard for raw JSONB values pulled out of `tasks.recurrencePattern`.
 *
 * The DB column is `jsonb` and we don't trust its shape blindly; this
 * lets callers feed in `unknown` without an unsafe cast.
 */
export const isRecurrencePattern = (value: unknown): value is RecurrencePattern => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type !== 'daily' && v.type !== 'weekly' && v.type !== 'monthly') return false;
  if (typeof v.interval !== 'number' || v.interval < 1) return false;
  return true;
};

const clampDayOfMonth = (year: number, month: number, day: number): number => {
  // Day-0 of the next month is the last day of `month`.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
};

/**
 * Calculate the next due date given a previous due date and pattern.
 *
 *   daily   → previousDue + (interval days)
 *   weekly  → next matching `daysOfWeek` after previousDue, or
 *             previousDue + (interval × 7) days when daysOfWeek is
 *             omitted
 *   monthly → previousDue + interval months, clamped to month length
 *
 * Returns null when the pattern has reached its `endDate` or
 * `occurrences` quota — `occurrencesUsed` lets the caller decide
 * whether the next spawn is still allowed.
 */
export const calculateNextDueDate = (
  previousDue: Date,
  pattern: RecurrencePattern,
  occurrencesUsed: number = 0,
): Date | null => {
  if (pattern.occurrences !== undefined && occurrencesUsed + 1 >= pattern.occurrences) {
    // We already spawned the last allowed occurrence (parent counts as #1).
    // Returning null tells the caller "no more children".
    if (occurrencesUsed + 1 > pattern.occurrences) return null;
  }

  const interval = Math.max(1, Math.floor(pattern.interval));
  let next: Date;

  switch (pattern.type as RecurrenceFrequency) {
    case 'daily': {
      next = new Date(previousDue.getTime() + interval * DAY_MS);
      break;
    }
    case 'weekly': {
      const days = pattern.daysOfWeek ?? [];
      if (days.length === 0) {
        next = new Date(previousDue.getTime() + interval * 7 * DAY_MS);
      } else {
        // Find the next day-of-week match after previousDue.
        const sorted = [...new Set(days)].sort((a, b) => a - b);
        const prevDow = previousDue.getUTCDay();
        let candidate: Date | null = null;
        for (const dow of sorted) {
          if (dow > prevDow) {
            const diff = dow - prevDow;
            candidate = new Date(previousDue.getTime() + diff * DAY_MS);
            break;
          }
        }
        if (!candidate) {
          // Wrap to next week (× interval).
          const diff = 7 * interval - prevDow + sorted[0]!;
          candidate = new Date(previousDue.getTime() + diff * DAY_MS);
        }
        next = candidate;
      }
      break;
    }
    case 'monthly': {
      const year = previousDue.getUTCFullYear();
      const month = previousDue.getUTCMonth();
      const baseDay = pattern.dayOfMonth ?? previousDue.getUTCDate();
      const newMonth = month + interval;
      const newYear = year + Math.floor(newMonth / 12);
      const adjustedMonth = ((newMonth % 12) + 12) % 12;
      const day = clampDayOfMonth(newYear, adjustedMonth, baseDay);
      next = new Date(
        Date.UTC(
          newYear,
          adjustedMonth,
          day,
          previousDue.getUTCHours(),
          previousDue.getUTCMinutes(),
          previousDue.getUTCSeconds(),
        ),
      );
      break;
    }
    default:
      return null;
  }

  if (pattern.endDate && next.getTime() > new Date(pattern.endDate).getTime()) {
    return null;
  }

  return next;
};

/**
 * Returns true when the pattern still has spawnable occurrences
 * given the count already created.
 */
export const hasRemainingOccurrences = (
  pattern: RecurrencePattern,
  occurrencesUsed: number,
): boolean => {
  if (pattern.occurrences === undefined) return true;
  return occurrencesUsed < pattern.occurrences;
};

export const DAY_IN_MS = DAY_MS;
