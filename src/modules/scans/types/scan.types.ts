import type { ProductRow } from '@/db/schema/products';
import type { ScanItemRow, ScanSessionRow } from '@/db/schema/scans';
import type { EanValidationResult } from '@/modules/ean-lists/types/import.types';

export type ScanSessionType =
  | 'audit'
  | 'shelf-check'
  | 'expiry-check'
  | 'inventory'
  | 'training'
  | 'general';

export type ScanSessionStatus = 'active' | 'completed' | 'abandoned' | 'expired';

export type ExpiryStatus = 'green' | 'yellow' | 'red' | 'unknown';

export type EanMatchStatus = 'matched' | 'unmatched' | 'no_list' | 'invalid' | 'unchecked';

export interface SessionSummary {
  sessionId: string;
  totalScans: number;
  uniqueProducts: number;
  matchedEans: number;
  unmatchedEans: number;
  expiredItems: number;
  nearExpiryItems: number;
  warningsCount: number;
  durationSeconds: number;
  scanRate: number;
}

export interface ScanSessionWithSummary extends ScanSessionRow {
  summary: SessionSummary;
}

export type ScanWarningType =
  | 'duplicate_in_session'
  | 'unmatched_ean'
  | 'no_active_list'
  | 'expired_product'
  | 'near_expiry'
  | 'invalid_ean'
  | 'product_unknown';

export type ScanWarningSeverity = 'info' | 'warning' | 'error';

export interface ScanWarning {
  type: ScanWarningType;
  message: string;
  severity: ScanWarningSeverity;
}

export interface ScanItemResult {
  scanItem: ScanItemRow;
  product?: ProductRow | null;
  eanValidation?: EanValidationResult;
  expiryStatus: ExpiryStatus;
  isDuplicate: boolean;
  duplicateOf?: ScanItemRow | null;
  warnings: ScanWarning[];
}

export interface DailyStats {
  date: string;
  totalSessions: number;
  totalScans: number;
  byType: Record<ScanSessionType, number>;
}

export type ScanSession = ScanSessionRow;
export type ScanItem = ScanItemRow;
