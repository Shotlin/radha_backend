import type { ExpiryStatus } from '../types/scan.types';

/**
 * BE-16 — Pure-function helpers shared by the session and item
 * services. No DI here so they can be unit-tested directly.
 */

/**
 * Days-until-expiry → traffic-light expiry status. Anything within 7
 * days (including past) is `red`; 8–30 days is `yellow`; > 30 days
 * is `green`. Missing date returns `unknown`.
 */
export const calculateExpiryStatus = (
  expiryDate: Date | null | undefined,
  now: Date = new Date(),
): ExpiryStatus => {
  if (!expiryDate) return 'unknown';
  const ms = expiryDate.getTime() - now.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 7) return 'red';
  if (days <= 30) return 'yellow';
  return 'green';
};

export interface ScanRateInput {
  totalScans: number;
  startedAt: Date;
  endedAt?: Date | null;
  now?: Date;
}

/** Scans per minute, rounded to 1 decimal. Returns 0 if duration is 0. */
export const calculateScanRate = (input: ScanRateInput): number => {
  const start = input.startedAt.getTime();
  const end = (input.endedAt ?? input.now ?? new Date()).getTime();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds === 0) return 0;
  return Math.round((input.totalScans / seconds) * 60 * 10) / 10;
};
