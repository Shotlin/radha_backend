import type { ExpiryAlertRow, ExpiryRecordRow, ExpiryThresholdRow } from '@/db/schema/expiry';

export type ExpiryStatus = 'green' | 'yellow' | 'red' | 'expired' | 'unknown';

export type ExpirySource = 'scan' | 'grn' | 'manual' | 'ocr';

export type AlertResolution =
  | 'discounted'
  | 'sold'
  | 'removed'
  | 'returned'
  | 'donated'
  | 'discarded';

export interface ResolvedThreshold {
  category: string;
  yellowDays: number;
  redDays: number;
  /** True when the value came from `DEFAULT_EXPIRY_THRESHOLDS` rather than the DB. */
  isPlatformDefault: boolean;
  /** Tenant scope of the resolved row (null when platform default). */
  tenantId: string | null;
}

export interface ExpiryFilters {
  status?: ExpiryStatus[];
  category?: string;
  productId?: string;
  fromDate?: Date;
  toDate?: Date;
  daysAhead?: number;
  limit?: number;
}

export interface ExpiryStats {
  storeId: string;
  total: number;
  green: number;
  yellow: number;
  red: number;
  expired: number;
  unknown: number;
}

export interface CategoryExpiryStats {
  category: string;
  green: number;
  yellow: number;
  red: number;
  expired: number;
  unknown: number;
}

export interface ExpiryForecastDay {
  date: string; // YYYY-MM-DD
  expiringCount: number;
  totalQuantity: number;
}

export interface ExpiryForecast {
  storeId: string;
  daysAhead: number;
  days: ExpiryForecastDay[];
}

export interface RecalculationResult {
  scanned: number;
  updated: number;
  alertsCreated: number;
}

export interface OcrDateValidationResult {
  valid: boolean;
  date?: Date;
  format?: string;
  warning?: string;
}

export type ExpiryRecord = ExpiryRecordRow;
export type ExpiryThreshold = ExpiryThresholdRow;
export type ExpiryAlert = ExpiryAlertRow;
