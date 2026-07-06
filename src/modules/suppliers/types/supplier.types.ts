import type {
  SupplierContactRow,
  SupplierPerformanceRow,
  SupplierRow,
} from '@/db/schema/suppliers';

/**
 * BE-25 — Suppliers domain types.
 *
 * Re-exports the Drizzle row inferences under domain-friendly names
 * and adds the wire-shape types consumed by the controller / service
 * layer. Anything that crosses the network boundary belongs here so
 * front-end clients can pull the same shape from
 * `` later.
 */

export type SupplierStatus = 'active' | 'inactive' | 'blacklisted' | 'pending';

export type Supplier = SupplierRow;
export type SupplierContact = SupplierContactRow;
export type SupplierPerformanceRecord = SupplierPerformanceRow;

/**
 * The "fat" shape returned by `findById` — supplier + contacts +
 * derived performance metrics. The performance object is computed
 * on-the-fly from the `supplier_performance` ledger so callers don't
 * have to join.
 */
export interface SupplierWithDetails extends Supplier {
  contacts: SupplierContact[];
  performance: SupplierPerformance;
}

/**
 * Aggregated performance view, computed by SupplierPerformanceService.
 *
 * `qualityScore` and `reliabilityScore` are 0–100 integers. Both fall
 * back to a heuristic when no GRNs have been posted yet — not null
 * — so the UI never has to render an empty state.
 */
export interface SupplierPerformance {
  supplierId: string;
  totalGrns: number;
  averageDeliveryDays: number;
  avgExpiryRemainingDays: number;
  shortShelfLifeIncidents: number;
  qualityScore: number;
  reliabilityScore: number;
  lastDeliveryDate: Date | null;
  totalAmountDelivered: number;
}

/**
 * Snapshot recorded on every posted GRN by `SupplierPerformanceService.record`.
 * BE-26 will hand this to the supplier performance service when GRNs are
 * posted; the shape is locked in here so the GRN module doesn't have
 * to import internal types.
 */
export interface PerformanceMetricInput {
  grnId: string;
  deliveryDays: number;
  expiryRemainingDays?: number;
  shortShelfLife: boolean;
  amount?: number;
  metadata?: Record<string, unknown>;
}

/* ─────────────────── Service / repository filters ─────────────────── */

export interface SupplierFilters {
  tenantId: string;
  q?: string;
  status?: SupplierStatus[];
  category?: string;
  city?: string;
  cursor?: string;
  limit?: number;
}

export interface PaginatedSuppliers {
  data: Supplier[];
  nextCursor: string | null;
  hasMore: boolean;
}

/* ─────────────────── Bulk import ─────────────────── */

/**
 * Per-row outcome from `SupplierImportService.processBuffer`.
 * Errors carry a row number so the front-end can highlight the
 * offending line in the uploaded sheet.
 */
export interface ImportRowError {
  row: number;
  field?: string;
  error: string;
}

export interface ImportResult {
  totalRows: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: ImportRowError[];
}

/* ─────────────────── Export ─────────────────── */

export type ExportFormat = 'xlsx' | 'csv';

/* ─────────────────── Status transitions ─────────────────── */

/**
 * Allowed forward transitions for the `status` column. Used by the
 * service layer to reject illegal transitions with a typed
 * `BUSINESS_RULE_VIOLATION` rather than letting them silently slip
 * through.
 */
export const SUPPLIER_STATUS_TRANSITIONS: Readonly<
  Record<SupplierStatus, ReadonlyArray<SupplierStatus>>
> = Object.freeze({
  pending: ['active', 'inactive', 'blacklisted'],
  active: ['inactive', 'blacklisted'],
  inactive: ['active', 'blacklisted'],
  // Admin override is still possible from blacklisted → active for compliance.
  blacklisted: ['active'],
});
