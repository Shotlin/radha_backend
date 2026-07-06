/**
 * BE-38 — Expiry Calendar types & interfaces.
 */

export type ExpiryColor = 'green' | 'yellow' | 'red';

export interface CalendarProduct {
  id: string;
  productName: string;
  productId: string | null;
  barcode: string | null;
  expiresAt: string;
  color: ExpiryColor;
  daysUntilExpiry: number;
  notes: string | null;
  userId: string;
}

export interface CalendarDay {
  date: string;
  count: number;
  dominantColor: ExpiryColor;
  products: CalendarProduct[];
}

export interface CalendarMonthSummary {
  green: number;
  yellow: number;
  red: number;
  expired: number;
}

export interface CalendarMonthResponse {
  month: string;
  totalProducts: number;
  summary: CalendarMonthSummary;
  days: CalendarDay[];
}

/** Thresholds for color coding (in days from today). */
export const EXPIRY_COLOR_THRESHOLDS = {
  /** Products expiring in < 7 days or already expired → red */
  RED_DAYS: 7,
  /** Products expiring in 7–30 days → yellow */
  YELLOW_DAYS: 30,
  /** Products expiring in > 30 days → green */
} as const;

/** IST offset in milliseconds (UTC + 5:30). */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
