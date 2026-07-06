import type { GrnEventRow, GrnHeaderRow, GrnItemRow } from '@/db/schema/grn';

/**
 * BE-26 — Domain types and cross-phase DI tokens.
 *
 * Schema rows are re-exported under shorter names so consumers
 * (`services/`, `repositories/`, controller, tests) can import a
 * stable identifier without reaching into `db/schema/grn`.
 */

export type Grn = GrnHeaderRow;
export type GrnItem = GrnItemRow;
export type GrnEvent = GrnEventRow;

export type GrnStatus = 'draft' | 'pending_review' | 'posted' | 'cancelled' | 'reversed';

export type GrnEventType =
  | 'created'
  | 'updated'
  | 'item_added'
  | 'item_updated'
  | 'item_removed'
  | 'submitted_for_review'
  | 'approved'
  | 'posted'
  | 'cancelled'
  | 'reversed';

/* ─────────────────── Validation result shapes ─────────────────── */

export type ValidationWarningType =
  | 'short_shelf_life'
  | 'price_variance'
  | 'duplicate_batch'
  | 'unknown_product'
  | 'past_expiry';

export interface ValidationError {
  field: string;
  itemId?: string;
  message: string;
}

export interface ValidationWarning {
  type: ValidationWarningType;
  message: string;
  itemId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/* ─────────────────── Posting / reversal results ─────────────────── */

export interface InventoryUpdate {
  productId: string;
  storeId: string;
  batchNumber?: string;
  quantityAdded: number;
  /** `null` when the inventory contract is unavailable (BE-27 pending). */
  newTotal: number | null;
}

export interface PostResult {
  grn: Grn;
  inventoryUpdates: InventoryUpdate[];
  expiryRecordsCreated: number;
  alertsGenerated: number;
}

export interface ReverseResult {
  grn: Grn;
  reversedAt: Date;
  inventoryReverted: number;
  expiryRecordsReverted: number;
}

/* ─────────────────── Detail view ─────────────────── */

export interface GrnWithDetails extends Grn {
  items: GrnItem[];
  events: GrnEvent[];
}

/* ─────────────────── Filters / stats ─────────────────── */

export interface ListGrnFilters {
  storeId?: string;
  supplierId?: string;
  status?: GrnStatus[];
  invoiceNumber?: string;
  fromDate?: Date;
  toDate?: Date;
  cursor?: string;
  limit?: number;
}

export interface GrnStats {
  storeId: string | null;
  total: number;
  byStatus: Record<GrnStatus, number>;
  totalAmount: number;
  totalItems: number;
  totalQuantity: number;
  shortShelfLifeCount: number;
}

/* ─────────────────── Cross-phase contracts ─────────────────── */

/**
 * BE-25 contract — the GRN posting service publishes per-delivery
 * metrics so vendor scorecards stay fresh without a nightly batch.
 *
 * BE-25's `SupplierPerformanceService` will be exposed under this
 * symbol so BE-26 doesn't import its concrete class. This keeps the
 * module boundary clean and lets the integration tests substitute a
 * stub.
 */
export const SUPPLIER_PERFORMANCE_TOKEN = Symbol('SUPPLIER_PERFORMANCE_TOKEN');

export interface SupplierPerformanceMetrics {
  grnId: string;
  /** -1 when the order date is unknown (drafts created without PO). */
  deliveryDays: number;
  expiryRemainingDays: number;
  shortShelfLife: boolean;
  amount?: number;
  postedAt: Date;
}

export interface ISupplierPerformanceService {
  updateMetrics(tenantId: string, supplierId: string, metrics: SupplierPerformanceMetrics): Promise<void>;
  /** Reverses a previously-posted metric set. Idempotent. */
  reverseMetrics(tenantId: string, supplierId: string, grnId: string): Promise<void>;
}

/**
 * BE-25 contract — minimal supplier read used by the GRN service to
 * verify a supplier exists, is active, and belongs to the tenant.
 */
export const SUPPLIER_LOOKUP_TOKEN = Symbol('SUPPLIER_LOOKUP_TOKEN');

export interface SupplierLookupRow {
  id: string;
  tenantId: string;
  name: string;
  status: 'active' | 'inactive' | 'blacklisted' | 'pending';
}

export interface ISupplierLookupService {
  findById(supplierId: string): Promise<SupplierLookupRow | null>;
}

/**
 * BE-27 contract — when the inventory module ships it will provide an
 * implementation that adjusts `inventory_items` and emits a stock
 * movement row per GRN line. Until then, BE-26 wires a stub that
 * records the intent in metadata only — flagged in the handoff as
 * the deferred contract.
 */
export const INVENTORY_SERVICE_TOKEN = Symbol('INVENTORY_SERVICE_TOKEN');

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
  /** GRN line item id, used for traceability. */
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
