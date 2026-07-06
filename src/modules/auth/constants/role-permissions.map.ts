import type { UserRole } from '@/shared-types';

import type { Permission } from '../types/permission.types';

/**
 * Role → permissions mapping.
 *
 * Each set is `ReadonlySet<Permission>` so callers can't accidentally
 * mutate it. `PermissionsService` consults this map first; users with
 * extra per-instance grants on `AuthenticatedUser.permissions` get the
 * union of both.
 */

const COMMON_BUSINESS_READS: Permission[] = [
  'users:read',
  'products:read',
  'scans:read',
  'tasks:read',
  'inventory:read',
  'grn:read',
];

export const ADMIN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  // Admin gets the union of every permission.
  'users:read',
  'users:write',
  'users:delete',
  'users:invite',
  'products:read',
  'products:write',
  'products:delete',
  'products:bulk-import',
  'scans:read',
  'scans:write',
  'scans:delete',
  'scans:export',
  'tasks:read',
  'tasks:write',
  'tasks:assign',
  'tasks:delete',
  'reports:read',
  'reports:generate',
  'reports:export',
  'inventory:read',
  'inventory:write',
  'inventory:adjust',
  'grn:read',
  'grn:write',
  'grn:post',
  'grn:cancel',
  'subscriptions:read',
  'subscriptions:manage',
  'owner:dashboard',
  'owner:analytics',
  'owner:billing',
  'admin:tenants:read',
  'admin:tenants:write',
  'admin:platform:settings',
  'admin:invite',
  'admin:revoke',
]);

export const OWNER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'users:read',
  'users:write',
  'users:invite',
  'products:read',
  'products:write',
  'products:delete',
  'products:bulk-import',
  'scans:read',
  'scans:write',
  'scans:export',
  'tasks:read',
  'tasks:write',
  'tasks:assign',
  'tasks:delete',
  'reports:read',
  'reports:generate',
  'reports:export',
  'inventory:read',
  'inventory:write',
  'inventory:adjust',
  'grn:read',
  'grn:write',
  'grn:post',
  'grn:cancel',
  'subscriptions:read',
  'subscriptions:manage',
  'owner:dashboard',
]);

export const MANAGER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  ...COMMON_BUSINESS_READS,
  'products:write',
  'scans:write',
  'scans:export',
  'tasks:write',
  'tasks:assign',
  'reports:generate',
  'reports:export',
  'inventory:write',
  'grn:write',
  'grn:post',
]);

export const STAFF_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'products:read',
  'scans:read',
  'scans:write',
  'tasks:read',
  'tasks:write',
  'inventory:read',
  'grn:read',
  'grn:write',
]);

export const AUDITOR_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'products:read',
  'scans:read',
  'scans:export',
  'tasks:read',
  'reports:read',
  'reports:generate',
  'reports:export',
  'inventory:read',
  'grn:read',
]);

/** BE-08 v2 ADDENDUM (Req 1, 26, 27, 30–35): Consumer permission set. */
export const CONSUMER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'consumer:scan',
  'consumer:save_product',
  'consumer:expiry_calendar:read',
  'consumer:allergen_profile:read',
  'consumer:allergen_profile:write',
  'consumer:family_sharing:invite',
  'consumer:family_sharing:remove',
  'consumer:recall_alerts:read',
  'consumer:scan_mode_toggle',
  'consumer:shopping_list:read',
  'consumer:shopping_list:write',
  'business:activate',
  'onboarding:select_segment',
]);

export const ROLE_PERMISSIONS_MAP: Record<UserRole, ReadonlySet<Permission>> = {
  admin: ADMIN_PERMISSIONS,
  owner: OWNER_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  staff: STAFF_PERMISSIONS,
  auditor: AUDITOR_PERMISSIONS,
  consumer: CONSUMER_PERMISSIONS,
};
