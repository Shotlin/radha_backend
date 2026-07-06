/**
 * Shared type contracts inlined from @radha/shared-types.
 * Previously a separate workspace package — now kept here since
 * radha_backend is deployed as a standalone repo.
 */

/* ============================================================================
 * Branded primitives
 * ========================================================================== */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type TenantId = Brand<string, 'TenantId'>;
export type StoreId = Brand<string, 'StoreId'>;
export type ProductId = Brand<string, 'ProductId'>;

/* ============================================================================
 * Domain enums
 * ========================================================================== */

export type UserRole = 'owner' | 'manager' | 'staff' | 'auditor' | 'consumer' | 'admin';

export type SubscriptionTier =
  | 'free_consumer'
  | 'premium_consumer'
  | 'trial_pro'
  | 'starter'
  | 'growth'
  | 'pro';

export type ScanOutputMode = 'basic' | 'comprehensive';

export type OnboardingSegment =
  | 'personal'
  | 'business_owner'
  | 'parent'
  | 'pharmacy'
  | 'institution'
  | 'auditor_invited';

/* ============================================================================
 * Common API envelope shapes
 * ========================================================================== */

export interface ApiErrorBody {
  errorId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

/* ============================================================================
 * Health check contract
 * ========================================================================== */

export interface HealthStatusResponse {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  service: string;
  version: string;
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: Record<string, 'ok' | 'failing' | 'unknown'>;
}

/* ============================================================================
 * Saved products
 * ========================================================================== */

export interface SavedProductDto {
  id: string;
  userId: string;
  productName: string;
  productId: string | null;
  barcode: string | null;
  /** ISO date YYYY-MM-DD */
  expiresAt: string | null;
  /** ISO datetime */
  markedConsumedAt: string | null;
  notes: string | null;
  /** ISO datetime */
  createdAt: string;
  /** ISO datetime */
  updatedAt: string;
}

export interface CreateSavedProductInput {
  productName: string;
  productId?: string;
  barcode?: string;
  expiresAt?: string;
  notes?: string;
}

export interface ListSavedProductsResponse {
  items: SavedProductDto[];
  nextCursor: string | null;
}
