import type { ScanItemRow, ScanSyncBatchRow } from '@/db/schema/scans';

import type { ScanItemResult } from './scan.types';

export type BulkSyncStatusType = ScanSyncBatchRow['status'];

export interface BulkSyncError {
  clientId: string;
  ean: string;
  error: string;
  errorCode: string;
}

export interface BulkSubmissionResult {
  batchId: string;
  status: BulkSyncStatusType;
  totalItems: number;
  estimatedDurationSeconds: number;
}

export interface BulkSyncProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  duplicates: number;
  percentage: number;
}

export interface BulkSyncStatus {
  batchId: string;
  status: BulkSyncStatusType;
  progress: BulkSyncProgress;
  startedAt: Date | null;
  completedAt: Date | null;
  errors: BulkSyncError[];
}

export interface BulkProcessResult {
  batchId: string;
  successful: ScanItemResult[];
  duplicates: Array<{ clientId: string; ean: string; existingId: string }>;
  failed: BulkSyncError[];
  totalProcessed: number;
  durationMs: number;
}

export type SyncBatchEntity = ScanSyncBatchRow;
export type SyncBatchScanItem = ScanItemRow;
