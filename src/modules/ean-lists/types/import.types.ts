import type {
  EanImportErrorRow,
  EanListItemRow,
  EanListRow,
  ImportBatchRow,
} from '@/db/schema/ean-lists';
import type { ProductRow } from '@/db/schema/products';

export type FileType = 'xlsx' | 'csv';

export type ImportBatchStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type EanListStatus = 'draft' | 'active' | 'archived';

export interface ParsedRow {
  rowNumber: number;
  ean: string;
  productName?: string;
  brand?: string;
  notes?: string;
  rawData: Record<string, string>;
}

export interface ValidatedRow {
  ean: string;
  productName?: string;
  brand?: string;
  notes?: string;
  rowNumber: number;
}

export interface InvalidRow {
  rowNumber: number;
  rawData: Record<string, string>;
  errors: string[];
}

export interface EanValidationResult {
  valid: boolean;
  ean: string;
  matched: boolean;
  listItem?: EanListItemRow;
  product?: ProductRow;
  reason?: 'not_in_list' | 'list_inactive' | 'no_active_list' | 'invalid_format' | 'no_store';
  validatedAt: Date;
}

export interface ImportInitResult {
  batchId: string;
  status: ImportBatchStatus;
  estimatedRows: number;
  estimatedDurationSeconds: number;
}

export interface ImportProgress {
  totalRows: number;
  processedRows: number;
  validRows: number;
  invalidRows: number;
  percentage: number;
}

export interface ImportStatus {
  batchId: string;
  status: ImportBatchStatus;
  progress: ImportProgress;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
}

export interface EanListWithStats extends EanListRow {
  matchedItems: number;
  unmatchedItems: number;
}

export interface ImportError extends EanImportErrorRow {}
export interface ImportBatch extends ImportBatchRow {}
export interface EanListItem extends EanListItemRow {}
export interface EanList extends EanListRow {}
