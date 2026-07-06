import type { DateRange } from '../types/analytics.types';

/**
 * BE-29 — Helpers for converting incoming `from`/`to` strings into a
 * normalized `DateRange` (UTC midnight start, UTC end-of-day exclusive).
 */

export const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const parseDateRange = (from: string, to: string): DateRange => {
  // Accept either "YYYY-MM-DD" or full ISO datetime.
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) {
    throw new Error('Invalid date range');
  }
  fromDate.setUTCHours(0, 0, 0, 0);
  toDate.setUTCHours(23, 59, 59, 999);
  return { from: fromDate, to: toDate };
};

export const startOfUtcDay = (d: Date): Date => {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
};

export const endOfUtcDay = (d: Date): Date => {
  const out = new Date(d);
  out.setUTCHours(23, 59, 59, 999);
  return out;
};
