import type { ReportScheduleFrequency } from '../types/report.types';

/**
 * Schedule helpers — pure date math so they can be tested without
 * touching the DB.
 *
 * The implementation deliberately uses UTC throughout. BE-24 will
 * apply tenant timezone shifts at the cron entry point so this layer
 * stays predictable.
 */

const DAYS_PER_WEEK = 7;
const HOURS_PER_DAY = 24;

export interface ScheduleSpec {
  frequency: ReportScheduleFrequency;
  hourOfDay: number;
  dayOfWeek?: number; // 0=Sun..6=Sat
  dayOfMonth?: number; // 1..28
}

export const computeNextRunAt = (spec: ScheduleSpec, reference: Date = new Date()): Date => {
  const ref = new Date(reference.getTime());
  ref.setUTCMilliseconds(0);
  ref.setUTCSeconds(0);
  ref.setUTCMinutes(0);

  switch (spec.frequency) {
    case 'daily':
      return computeDailyNext(ref, spec.hourOfDay);
    case 'weekly':
      return computeWeeklyNext(ref, spec.hourOfDay, clampDayOfWeek(spec.dayOfWeek ?? 1));
    case 'monthly':
      return computeMonthlyNext(ref, spec.hourOfDay, clampDayOfMonth(spec.dayOfMonth ?? 1));
    default:
      throw new Error(`Unknown frequency: ${spec.frequency as string}`);
  }
};

const computeDailyNext = (ref: Date, hour: number): Date => {
  const out = new Date(ref.getTime());
  out.setUTCHours(hour, 0, 0, 0);
  if (out.getTime() <= ref.getTime()) {
    out.setUTCDate(out.getUTCDate() + 1);
  }
  return out;
};

const computeWeeklyNext = (ref: Date, hour: number, dayOfWeek: number): Date => {
  const out = new Date(ref.getTime());
  out.setUTCHours(hour, 0, 0, 0);
  const diff = (dayOfWeek - out.getUTCDay() + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  out.setUTCDate(out.getUTCDate() + diff);
  if (out.getTime() <= ref.getTime()) {
    out.setUTCDate(out.getUTCDate() + DAYS_PER_WEEK);
  }
  return out;
};

const computeMonthlyNext = (ref: Date, hour: number, dayOfMonth: number): Date => {
  const out = new Date(ref.getTime());
  out.setUTCDate(dayOfMonth);
  out.setUTCHours(hour, 0, 0, 0);
  if (out.getTime() <= ref.getTime()) {
    out.setUTCMonth(out.getUTCMonth() + 1);
    out.setUTCDate(dayOfMonth);
    out.setUTCHours(hour, 0, 0, 0);
  }
  return out;
};

const clampDayOfWeek = (dow: number): number => {
  if (!Number.isFinite(dow)) return 1;
  return ((Math.trunc(dow) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
};

const clampDayOfMonth = (dom: number): number => {
  if (!Number.isFinite(dom)) return 1;
  return Math.min(28, Math.max(1, Math.trunc(dom)));
};

/**
 * Estimate generation duration in seconds given the breadth of the
 * request. The formula is deliberately conservative — better to over-
 * estimate than under-promise. Bounded to [5, 300] seconds.
 */
export const estimateDurationSeconds = (
  fromMs: number,
  toMs: number,
  formatCount: number,
): number => {
  const days = Math.max(1, Math.floor((toMs - fromMs) / (HOURS_PER_DAY * 3600 * 1000)));
  const raw = Math.ceil(days / 30) + Math.max(1, formatCount) * 2;
  return Math.max(5, Math.min(300, raw));
};
