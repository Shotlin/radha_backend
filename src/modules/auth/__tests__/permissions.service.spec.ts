import { PermissionsService } from '../services/permissions.service';
import type { AuthenticatedUser, Permission } from '../types/permission.types';

const buildUser = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  id: 'u-1',
  tenantId: 't-1',
  role: 'consumer',
  permissions: [],
  storeIds: [],
  sessionId: 's-1',
  subscriptionTier: 'free_consumer',
  ...overrides,
});

describe('PermissionsService', () => {
  const svc = new PermissionsService();

  describe('hasPermission', () => {
    it('grants every consumer permission to a Consumer user', () => {
      const user = buildUser({ role: 'consumer' });
      expect(svc.hasPermission(user, 'consumer:scan')).toBe(true);
      expect(svc.hasPermission(user, 'consumer:save_product')).toBe(true);
      expect(svc.hasPermission(user, 'business:activate')).toBe(true);
    });

    it('does not grant business permissions to Consumer', () => {
      const user = buildUser({ role: 'consumer' });
      expect(svc.hasPermission(user, 'products:write')).toBe(false);
      expect(svc.hasPermission(user, 'grn:post')).toBe(false);
    });

    it('admin holds every catalog permission', () => {
      const user = buildUser({ role: 'admin' });
      const allBusiness: Permission[] = [
        'users:write',
        'products:delete',
        'inventory:adjust',
        'admin:tenants:write',
      ];
      expect(svc.hasAllPermissions(user, allBusiness)).toBe(true);
    });

    it('per-instance grants augment role permissions', () => {
      const user = buildUser({ role: 'staff', permissions: ['products:write'] as Permission[] });
      expect(svc.hasPermission(user, 'products:write')).toBe(true);
      expect(svc.hasPermission(user, 'products:delete')).toBe(false);
    });
  });

  describe('canAccessTenant', () => {
    it('accepts matching tenant', () => {
      expect(svc.canAccessTenant(buildUser({ tenantId: 't-1' }), 't-1')).toBe(true);
    });
    it('rejects mismatched tenant', () => {
      expect(svc.canAccessTenant(buildUser({ tenantId: 't-1' }), 't-2')).toBe(false);
    });
    it('admin bypasses tenant scope', () => {
      expect(svc.canAccessTenant(buildUser({ role: 'admin', tenantId: null }), 'any')).toBe(true);
    });
    it('null tenant on user denies any tenant access', () => {
      expect(svc.canAccessTenant(buildUser({ tenantId: null }), 't-1')).toBe(false);
    });
  });

  describe('canAccessStore', () => {
    it('owner has access to every tenant store implicitly', () => {
      expect(svc.canAccessStore(buildUser({ role: 'owner' }), 'store-x')).toBe(true);
    });
    it('staff is limited to assigned stores', () => {
      const u = buildUser({ role: 'staff', storeIds: ['s-1', 's-2'] });
      expect(svc.canAccessStore(u, 's-1')).toBe(true);
      expect(svc.canAccessStore(u, 's-3')).toBe(false);
    });
  });

  describe('getEntitlements', () => {
    it('Free Consumer caps scans and saves and disables Premium features', () => {
      const ent = svc.getEntitlements(buildUser({ subscriptionTier: 'free_consumer' }));
      expect(ent.scansPerDay).toBe(50);
      expect(ent.savedProductsLimit).toBe(5);
      expect(ent.comprehensiveScanAccess).toBe(false);
      expect(ent.familySharing).toBe(false);
      expect(ent.allergenProfileMaxFamilyMembers).toBe(1);
    });

    it('Premium Consumer unlocks Premium features', () => {
      const ent = svc.getEntitlements(buildUser({ subscriptionTier: 'premium_consumer' }));
      expect(ent.comprehensiveScanAccess).toBe(true);
      expect(ent.familySharing).toBe(true);
      expect(ent.allergenProfileMaxFamilyMembers).toBe(5);
      expect(ent.affiliateAlternatives).toBe(true);
      expect(ent.scansPerDay).toBe(Number.POSITIVE_INFINITY);
    });

    it('Trial Pro = Pro features but capped Starter limits (entitlement-side)', () => {
      const ent = svc.getEntitlements(buildUser({ subscriptionTier: 'trial_pro' }));
      expect(ent.comprehensiveScanAccess).toBe(true);
      expect(ent.familySharing).toBe(true);
    });

    it('Starter / Growth / Pro do not unlock consumer extras', () => {
      for (const tier of ['starter', 'growth', 'pro'] as const) {
        const ent = svc.getEntitlements(buildUser({ subscriptionTier: tier }));
        expect(ent.comprehensiveScanAccess).toBe(false);
        expect(ent.familySharing).toBe(false);
        expect(ent.expiryCalendar).toBe(false);
      }
    });
  });
});
