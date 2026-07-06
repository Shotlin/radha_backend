import type { InventoryBatchRow } from '@/db/schema/inventory-batches';
import type { InventoryItemRow } from '@/db/schema/inventory-items';
import type { LowStockAlertRow } from '@/db/schema/low-stock-alerts';
import type { LowStockRuleRow } from '@/db/schema/low-stock-rules';
import type { StockCountLineRow } from '@/db/schema/stock-count-lines';
import type { StockCountRow } from '@/db/schema/stock-counts';
import type { StockMovementRow } from '@/db/schema/stock-movements';

/**
 * BE-27 — Public domain types for the inventory module.
 *
 * Schema rows are re-exported under shorter aliases so consumers
 * (`services/`, `repositories/`, controller, tests) can import a
 * stable identifier without reaching into `db/schema/...`.
 */

export type InventoryItem = InventoryItemRow;
export type InventoryBatch = InventoryBatchRow;
export type StockMovement = StockMovementRow;
export type LowStockRule = LowStockRuleRow;
export type LowStockAlert = LowStockAlertRow;
export type StockCount = StockCountRow;
export type StockCountLine = StockCountLineRow;

/* ─────────────────── Movement enums ─────────────────── */

export type StockMovementType = 'in' | 'out' | 'adjustment' | 'transfer';

export type StockMovementReason =
  | 'grn_post'
  | 'grn_reversal'
  | 'manual_in'
  | 'sale'
  | 'expired'
  | 'damaged'
  | 'returned'
  | 'theft'
  | 'count_adjustment'
  | 'correction';

export type StockCountStatus = 'in_progress' | 'completed' | 'cancelled';

/* ─────────────────── Service input shapes ─────────────────── */

export interface StockInInput {
  productId: string;
  storeId: string;
  quantity: number;
  reason: StockMovementReason;
  batchNumber?: string;
  expiryDate?: Date;
  manufactureDate?: Date;
  unitCost?: number;
  /** Optional source identifier (e.g. GRN line id). Free-form. */
  reference?: string;
  sourceType?: string;
  sourceId?: string;
  notes?: string;
}

export interface StockOutInput {
  productId: string;
  storeId: string;
  quantity: number;
  reason: StockMovementReason;
  /** When set, deduct only from the named batch. Otherwise FIFO. */
  batchNumber?: string;
  sourceType?: string;
  sourceId?: string;
  notes?: string;
}

export interface AdjustStockInput {
  productId: string;
  storeId: string;
  newQuantity: number;
  reason: StockMovementReason;
  notes?: string;
}

export interface StockMovementResult {
  movement: StockMovement;
  inventoryItem: InventoryItem;
  newQuantity: number;
  alertsGenerated: number;
}

export interface InventorySummary {
  storeId: string;
  totalProducts: number;
  totalQuantity: number;
  totalValue: number | null;
  byCategory: Record<string, { count: number; quantity: number }>;
  lowStockCount: number;
  expiringSoonCount: number;
  expiredCount: number;
}

export interface CategoryBreakdownEntry {
  category: string;
  productCount: number;
  totalQuantity: number;
}

export interface LowStockRuleInput {
  productId?: string;
  category?: string;
  storeId: string;
  threshold: number;
  enabled?: boolean;
  notes?: string;
}

export interface StartStockCountInput {
  storeId: string;
  notes?: string;
  startedAt?: Date;
}

export interface RecordStockCountLineInput {
  productId: string;
  countedQuantity: number;
  notes?: string;
}

export interface StockCountResult {
  countId: string;
  totalProducts: number;
  variances: number;
  totalVarianceQuantity: number;
  adjustmentsCreated: number;
}

export interface ListInventoryFilters {
  storeId?: string;
  productId?: string;
  isLowStock?: boolean;
  cursor?: string;
  limit?: number;
}

export interface MovementHistoryFilters {
  storeId?: string;
  productId?: string;
  type?: StockMovementType;
  reason?: StockMovementReason;
  fromDate?: Date;
  toDate?: Date;
  cursor?: string;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/* ─────────────────── Cross-phase contracts ─────────────────── */

/**
 * BE-26 GRN posting service injects this token. Our `InventoryService`
 * implements both methods so the GRN module can swap the in-process
 * stub for the real thing at orchestrator wiring time.
 */
export interface InventoryMovementRequest {
  tenantId: string;
  storeId: string;
  productId: string;
  quantity: number;
  batchNumber?: string;
  expiryDate?: Date;
  unitCost?: number;
  source: 'grn' | 'grn_reversal';
  sourceId: string;
  sourceLineId: string;
  actorId: string;
}

export interface InventoryMovementResult {
  inventoryItemId: string;
  stockMovementId: string;
  newQuantity: number;
}

export interface IInventoryService {
  applyInbound(req: InventoryMovementRequest): Promise<InventoryMovementResult>;
  applyOutbound(req: InventoryMovementRequest): Promise<InventoryMovementResult>;
}
