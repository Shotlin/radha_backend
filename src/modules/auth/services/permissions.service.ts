import { Injectable } from '@nestjs/common';

import type { SubscriptionTier, UserRole } from '@/shared-types';

import { ROLE_PERMISSIONS_MAP } from '../constants/role-permissions.map';
import type {
  AuthenticatedUser,
  ConsumerEntitlements,
  IPermissionsService,
  Permission,
} from '../types/permission.types';

const CONSUMER_DEFAULT_ENTITLEMENTS: ConsumerEntitlements = {
  scansPerDay: 0,
  savedProductsLimit: 0,
  comprehensiveScanAccess: false,
  allergenProfileMaxFamilyMembers: 0,
  familySharing: false,
  expiryCalendar: false,
  recallAlerts: false,
  multiLanguage: true,
  affiliateAlternatives: false,
};

const ENTITLEMENT_TABLE: Record<SubscriptionTier, ConsumerEntitlements> = {
  free_consumer: {
    ...CONSUMER_DEFAULT_ENTITLEMENTS,
    scansPerDay: 50,
    savedProductsLimit: 5,
    expiryCalendar: true,
    recallAlerts: true,
    allergenProfileMaxFamilyMembers: 1,
  },
  premium_consumer: {
    scansPerDay: Number.POSITIVE_INFINITY,
    savedProductsLimit: Number.POSITIVE_INFINITY,
    comprehensiveScanAccess: true,
    allergenProfileMaxFamilyMembers: 5,
    familySharing: true,
    expiryCalendar: true,
    recallAlerts: true,
    multiLanguage: true,
    affiliateAlternatives: true,
  },
  trial_pro: {
    // Trial Pro = Pro features but capped at Starter limits (1 store / 5 users / 5K scans/mo).
    scansPerDay: Number.POSITIVE_INFINITY,
    savedProductsLimit: Number.POSITIVE_INFINITY,
    comprehensiveScanAccess: true,
    allergenProfileMaxFamilyMembers: 5,
    familySharing: true,
    expiryCalendar: true,
    recallAlerts: true,
    multiLanguage: true,
    affiliateAlternatives: true,
  },
  starter: {
    ...CONSUMER_DEFAULT_ENTITLEMENTS,
    scansPerDay: Number.POSITIVE_INFINITY,
    savedProductsLimit: Number.POSITIVE_INFINITY,
  },
  growth: {
    ...CONSUMER_DEFAULT_ENTITLEMENTS,
    scansPerDay: Number.POSITIVE_INFINITY,
    savedProductsLimit: Number.POSITIVE_INFINITY,
  },
  pro: {
    ...CONSUMER_DEFAULT_ENTITLEMENTS,
    scansPerDay: Number.POSITIVE_INFINITY,
    savedProductsLimit: Number.POSITIVE_INFINITY,
  },
};

/**
 * Permission resolution and entitlement lookup.
 *
 *   - `getRolePermissions(role)` → static role map.
 *   - `hasPermission(user, p)` → considers role + per-user grants.
 *   - `canAccessTenant` / `canAccessStore` → enforce admin/owner overrides.
 *   - `getEntitlements(user)` → per-tier feature gating used by every
 *     consumer-side controller.
 */
@Injectable()
export class PermissionsService implements IPermissionsService {
  getRolePermissions(role: UserRole): ReadonlySet<Permission> {
    return ROLE_PERMISSIONS_MAP[role] ?? new Set<Permission>();
  }

  hasPermission(user: AuthenticatedUser, permission: Permission): boolean {
    if (user.permissions.includes(permission)) return true;
    return this.getRolePermissions(user.role).has(permission);
  }

  hasAnyPermission(user: AuthenticatedUser, permissions: Permission[]): boolean {
    return permissions.some((p) => this.hasPermission(user, p));
  }

  hasAllPermissions(user: AuthenticatedUser, permissions: Permission[]): boolean {
    return permissions.every((p) => this.hasPermission(user, p));
  }

  canAccessTenant(user: AuthenticatedUser, tenantId: string): boolean {
    if (user.role === 'admin') return true;
    return user.tenantId !== null && user.tenantId === tenantId;
  }

  canAccessStore(user: AuthenticatedUser, storeId: string): boolean {
    if (user.role === 'admin') return true;
    if (user.role === 'owner') return true;
    return user.storeIds.includes(storeId);
  }

  getEntitlements(user: AuthenticatedUser): ConsumerEntitlements {
    return ENTITLEMENT_TABLE[user.subscriptionTier] ?? CONSUMER_DEFAULT_ENTITLEMENTS;
  }
}
