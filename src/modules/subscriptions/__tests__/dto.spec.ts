import { CancelSubscriptionSchema } from '../dto/cancel-subscription.dto';
import { CreateSubscriptionSchema } from '../dto/create-subscription.dto';
import { UpgradePlanSchema } from '../dto/upgrade-plan.dto';

describe('DTO schemas', () => {
  describe('UpgradePlanSchema', () => {
    it('accepts valid paid plan codes', () => {
      expect(UpgradePlanSchema.parse({ planCode: 'starter' })).toEqual({ planCode: 'starter' });
      expect(UpgradePlanSchema.parse({ planCode: 'growth' })).toEqual({ planCode: 'growth' });
      expect(UpgradePlanSchema.parse({ planCode: 'pro' })).toEqual({ planCode: 'pro' });
    });

    it('rejects trial as an upgrade target', () => {
      const result = UpgradePlanSchema.safeParse({ planCode: 'trial' });
      expect(result.success).toBe(false);
    });

    it('rejects unknown plan codes', () => {
      expect(UpgradePlanSchema.safeParse({ planCode: 'enterprise' }).success).toBe(false);
      expect(UpgradePlanSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('CancelSubscriptionSchema', () => {
    it('accepts a non-empty reason ≤500 chars', () => {
      const reason = 'Too expensive';
      expect(CancelSubscriptionSchema.parse({ reason })).toEqual({ reason });
    });

    it('rejects empty reason', () => {
      expect(CancelSubscriptionSchema.safeParse({ reason: '' }).success).toBe(false);
      expect(CancelSubscriptionSchema.safeParse({ reason: '   ' }).success).toBe(false);
    });

    it('rejects reason > 500 chars', () => {
      const long = 'a'.repeat(501);
      expect(CancelSubscriptionSchema.safeParse({ reason: long }).success).toBe(false);
    });
  });

  describe('CreateSubscriptionSchema', () => {
    it('defaults planCode to trial when omitted', () => {
      const out = CreateSubscriptionSchema.parse({
        tenantId: '00000000-0000-0000-0000-000000000001',
      });
      expect(out.planCode).toBe('trial');
    });

    it('rejects non-uuid tenantId', () => {
      expect(CreateSubscriptionSchema.safeParse({ tenantId: 'not-a-uuid' }).success).toBe(false);
    });
  });
});
