import type { ExpiryStatus } from '../types/expiry.types';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * BE-18 — Pure helpers for expiry classification.
 *
 * Business rule:
 *   days < 0           → expired
 *   days <= redDays    → red
 *   days <= yellowDays → yellow
 *   else               → green
 *   no expiryDate      → unknown
 */

export interface ThresholdLike {
  yellowDays: number;
  redDays: number;
}

export const daysUntilExpiry = (
  expiryDate: Date | null | undefined,
  referenceDate: Date = new Date(),
): number | null => {
  if (!expiryDate) return null;
  const ms = expiryDate.getTime() - referenceDate.getTime();
  return Math.floor(ms / MS_PER_DAY);
};

export const calculateExpiryStatus = (
  expiryDate: Date | null | undefined,
  threshold: ThresholdLike,
  referenceDate: Date = new Date(),
): ExpiryStatus => {
  const days = daysUntilExpiry(expiryDate, referenceDate);
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= threshold.redDays) return 'red';
  if (days <= threshold.yellowDays) return 'yellow';
  return 'green';
};

export const statusColor = (status: ExpiryStatus): 'green' | 'yellow' | 'red' | 'gray' => {
  if (status === 'green') return 'green';
  if (status === 'yellow') return 'yellow';
  if (status === 'red' || status === 'expired') return 'red';
  return 'gray';
};

/**
 * Mid-range OCR confidence threshold below which we surface a
 * "please verify" warning to the Mobile_App. Calibrated from ML Kit
 * production telemetry — < 0.7 has a > 5% mis-read rate.
 */
export const OCR_CONFIDENCE_WARNING_THRESHOLD = 0.7;

/**
 * Sanity bounds for OCR-extracted dates: anything more than 10 years
 * outside the present is almost certainly an OCR misread (e.g. 2099
 * for 2025) rather than a legitimate value.
 */
export const OCR_DATE_PAST_LIMIT_YEARS = 10;
export const OCR_DATE_FUTURE_LIMIT_YEARS = 10;
