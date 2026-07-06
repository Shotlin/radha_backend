import type { SubscriptionTier, UserRole } from '@/shared-types';

/**
 * Catalog of permissions used by `RolesGuard` / `PermissionsGuard`.
 *
 * Strings are namespaced by domain (`products:read`, `consumer:scan`, …)
 * so they remain readable in audit trails and Sentry tags. Adding new
 * values is fine; removing them is a breaking change for the role map.
 */

export type Permission =
  // ── Users / identity ────────────────────────────────────────────
  | 'users:read'
  | 'users:write'
  | 'users:delete'
  | 'users:invite'
  // ── Products ────────────────────────────────────────────────────
  | 'products:read'
  | 'products:write'
  | 'products:delete'
  | 'products:bulk-import'
  // ── Scans ───────────────────────────────────────────────────────
  | 'scans:read'
  | 'scans:write'
  | 'scans:delete'
  | 'scans:export'
  // ── Tasks ───────────────────────────────────────────────────────
  | 'tasks:read'
  | 'tasks:write'
  | 'tasks:assign'
  | 'tasks:delete'
  // ── Reports ─────────────────────────────────────────────────────
  | 'reports:read'
  | 'reports:generate'
  | 'reports:export'
  // ── Inventory ───────────────────────────────────────────────────
  | 'inventory:read'
  | 'inventory:write'
  | 'inventory:adjust'
  // ── GRN ─────────────────────────────────────────────────────────
  | 'grn:read'
  | 'grn:write'
  | 'grn:post'
  | 'grn:cancel'
  // ── Subscriptions ───────────────────────────────────────────────
  | 'subscriptions:read'
  | 'subscriptions:manage'
  // ── Owner-tier business features ────────────────────────────────
  | 'owner:dashboard'
  | 'owner:analytics'
  | 'owner:billing'
  // ── Platform admin ──────────────────────────────────────────────
  | 'admin:tenants:read'
  | 'admin:tenants:write'
  | 'admin:platform:settings'
  | 'admin:invite'
  | 'admin:revoke'
  // ── BE-08 v2 ADDENDUM (Consumer + onboarding + business activation) ──
  | 'consumer:scan'
  | 'consumer:save_product'
  | 'consumer:expiry_calendar:read'
  | 'consumer:allergen_profile:read'
  | 'consumer:allergen_profile:write'
  | 'consumer:family_sharing:invite'
  | 'consumer:family_sharing:remove'
  | 'consumer:recall_alerts:read'
  | 'consumer:scan_mode_toggle'
  | 'consumer:shopping_list:read'
  | 'consumer:shopping_list:write'
  | 'business:activate'
  | 'onboarding:select_segment';

/**
 * The shape attached to `req.user` once JwtAuthGuard accepts a request.
 *
 * `tenantId` is nullable to accommodate brand-new Consumer signups
 * whose personal tenant hasn't been provisioned yet (BE-09 v2 ADDENDUM
 * does the bootstrap). Code that performs a tenant-scoped query MUST
 * call `assertTenant(user)` first.
 */
export interface AuthenticatedUser {
  id: string;
  tenantId: string | null;
  role: UserRole;
  permissions: Permission[];
  storeIds: string[];
  sessionId: string;
  subscriptionTier: SubscriptionTier;
  onboardingSegment?: string;
  familyPrimaryUserId?: string;
}

/**
 * Per-tier consumer entitlements. Returned by
 * `PermissionsService.getEntitlements(user)` and consumed by:
 *   - BE-10 v2 scan endpoint (gates `mode=comprehensive`),
 *   - BE-30 expiry calendar (Premium-only family union),
 *   - BE-32 allergen profile (1 vs 5 family members),
 *   - BE-46 rate limiter (per-tier daily quotas).
 */
export interface ConsumerEntitlements {
  scansPerDay: number;
  savedProductsLimit: number;
  comprehensiveScanAccess: boolean;
  allergenProfileMaxFamilyMembers: number;
  familySharing: boolean;
  expiryCalendar: boolean;
  recallAlerts: boolean;
  multiLanguage: boolean;
  affiliateAlternatives: boolean;
}

export interface IPermissionsService {
  getRolePermissions(role: UserRole): ReadonlySet<Permission>;
  hasPermission(user: AuthenticatedUser, permission: Permission): boolean;
  hasAnyPermission(user: AuthenticatedUser, permissions: Permission[]): boolean;
  hasAllPermissions(user: AuthenticatedUser, permissions: Permission[]): boolean;
  canAccessTenant(user: AuthenticatedUser, tenantId: string): boolean;
  canAccessStore(user: AuthenticatedUser, storeId: string): boolean;
  getEntitlements(user: AuthenticatedUser): ConsumerEntitlements;
}
