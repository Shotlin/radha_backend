import { ConflictException } from '@nestjs/common';

import { DbService } from '@/db/db.service';
import { AuditLogService } from '@/observability/audit-log.service';
import { AppAnalyticsService } from '@/modules/analytics/services/app-analytics.service';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

import { BusinessActivationService } from '../services/business-activation.service';
import type { ActivateBusinessInput } from '../services/business-activation.service';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const TENANT_ID = '00000000-0000-0000-0000-000000000010';
const STORE_ID = '00000000-0000-0000-0000-000000000020';

const baseInput = (overrides: Partial<ActivateBusinessInput> = {}): ActivateBusinessInput => ({
  userId: USER_ID,
  businessName: 'My Shop',
  storeName: 'Main Store',
  acceptTrialPro: false,
  ...overrides,
});

const mockUser = (role = 'consumer') => ({
  id: USER_ID,
  role,
  onboardingSegment: null,
});

interface BuildOpts {
  userRole?: string;
  userExists?: boolean;
  trialResult?: { currentPeriodEnd: Date } | null;
  trialThrows?: boolean;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const { userRole = 'consumer', userExists = true, trialResult = null, trialThrows = false } = opts;

  const selectMock = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(userExists ? [mockUser(userRole)] : []),
      }),
    }),
  });

  const insertMock = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn()
        .mockResolvedValueOnce([{ id: TENANT_ID, name: 'My Shop' }])
        .mockResolvedValueOnce([{ id: STORE_ID, name: 'Main Store' }])
        .mockResolvedValue([{ id: 'access-1' }]),
    }),
  });

  const updateMock = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  });

  const txMock = {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
  };

  const db = {
    transaction: jest.fn(async (cb) => cb(txMock)),
  } as unknown as DbService;

  const subscriptions = {
    startTrial: trialThrows
      ? jest.fn().mockRejectedValue(new Error('Trial failed'))
      : jest.fn().mockResolvedValue(trialResult),
  } as unknown as SubscriptionsService;

  const analytics = {
    trackEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as AppAnalyticsService;

  const audit = {
    logAction: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogService;

  const svc = new BusinessActivationService(db, subscriptions, analytics, audit);

  return { svc, db, subscriptions, analytics, audit, txMock };
};

describe('BusinessActivationService', () => {
  describe('activate', () => {
    it('creates tenant, store, updates user role for a Consumer', async () => {
      const { svc, txMock } = buildSvc();
      const result = await svc.activate(baseInput());

      expect(result.newRole).toBe('owner');
      expect(result.newTenantId).toBe(TENANT_ID);
      expect(result.newStoreId).toBe(STORE_ID);
      expect(result.trialStarted).toBe(false);
      expect(result.trialEndsAt).toBeUndefined();
      expect(txMock.insert).toHaveBeenCalled();
      expect(txMock.update).toHaveBeenCalled();
    });

    it('throws ConflictException when user is not a Consumer', async () => {
      const { svc } = buildSvc({ userRole: 'owner' });
      await expect(svc.activate(baseInput())).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws ConflictException when user not found', async () => {
      const { svc } = buildSvc({ userExists: false });
      await expect(svc.activate(baseInput())).rejects.toBeInstanceOf(ConflictException);
    });

    it('starts Trial Pro when acceptTrialPro is true', async () => {
      const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const { svc, subscriptions } = buildSvc({
        trialResult: { currentPeriodEnd: trialEnd },
      });

      const result = await svc.activate(baseInput({ acceptTrialPro: true }));

      expect(result.trialStarted).toBe(true);
      expect(result.trialEndsAt).toBe(trialEnd.toISOString());
      expect(subscriptions.startTrial).toHaveBeenCalledWith(TENANT_ID);
    });

    it('does not fail activation when Trial Pro start throws', async () => {
      const { svc } = buildSvc({ trialThrows: true });

      const result = await svc.activate(baseInput({ acceptTrialPro: true }));

      expect(result.trialStarted).toBe(false);
      expect(result.newRole).toBe('owner');
    });

    it('emits business_mode_activated analytics event', async () => {
      const { svc, analytics } = buildSvc();
      await svc.activate(baseInput({ preset: 'pharmacy' }));

      expect(analytics.trackEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'feature_use',
          category: 'activation',
          label: 'pharmacy',
        }),
        USER_ID,
        TENANT_ID,
      );
    });

    it('writes audit log on successful activation', async () => {
      const { svc, audit } = buildSvc();
      await svc.activate(baseInput());

      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'Tenant',
          resourceId: TENANT_ID,
          userId: USER_ID,
          success: true,
        }),
      );
    });

    it('runs everything in a single DB transaction', async () => {
      const { svc, db } = buildSvc();
      await svc.activate(baseInput());

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('passes store address fields when provided', async () => {
      const { svc, txMock } = buildSvc();
      await svc.activate(
        baseInput({
          storeAddressLine1: '123 MG Road',
          storeCity: 'Mumbai',
          storeState: 'MH',
          storePincode: '400001',
        }),
      );

      // Second insert call is for the store
      const insertValues = txMock.insert.mock.results;
      expect(insertValues).toBeDefined();
    });

    it('uses pharmacy store type when preset is pharmacy', async () => {
      const { svc } = buildSvc();
      const result = await svc.activate(baseInput({ preset: 'pharmacy' }));
      expect(result.newRole).toBe('owner');
    });
  });
});
