import { DomainConflictException } from '@/common/errors/business.exception';

import { TenantOnboardingService } from '../services/tenant-onboarding.service';
import type { TenantsRepository } from '../repositories/tenants.repository';

describe('TenantOnboardingService.validateSubdomain', () => {
  const buildSvc = (existing: { subdomain: string } | null): TenantOnboardingService => {
    const tenants = {
      findBySubdomain: jest.fn().mockResolvedValue(existing),
    } as unknown as TenantsRepository;
    return new TenantOnboardingService(
      {} as never,
      tenants,
      { logAction: jest.fn() } as never,
      {} as never,
    );
  };

  it.each(['admin', 'api', 'www', 'app', 'support', 'help', 'demo'])(
    'rejects reserved subdomain %s',
    async (sub) => {
      const result = await buildSvc(null).validateSubdomain(sub);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Reserved subdomain');
    },
  );

  it('rejects an already-taken subdomain', async () => {
    const result = await buildSvc({ subdomain: 'taken' }).validateSubdomain('taken');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Subdomain already taken');
  });

  it('accepts a fresh subdomain', async () => {
    const result = await buildSvc(null).validateSubdomain('fresh-shop');
    expect(result.valid).toBe(true);
  });
});

describe('TenantOnboardingService.onboard', () => {
  it('throws DomainConflictException for reserved subdomain before touching the DB', async () => {
    const tenants = {
      findBySubdomain: jest.fn().mockResolvedValue(null),
    } as unknown as TenantsRepository;
    const db = { transaction: jest.fn() };
    const svc = new TenantOnboardingService(
      db as never,
      tenants,
      { logAction: jest.fn() } as never,
      {} as never,
    );

    await expect(
      svc.onboard({
        businessName: 'X',
        subdomain: 'admin',
        ownerName: 'Y',
        email: 'a@b.com',
        mobile: '9876543210',
        storeName: 'S',
        country: 'IN',
      }),
    ).rejects.toBeInstanceOf(DomainConflictException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
