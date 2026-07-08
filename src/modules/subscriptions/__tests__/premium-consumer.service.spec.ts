import { Test, TestingModule } from '@nestjs/testing';

import { PremiumConsumerService } from '../services/premium-consumer.service';
import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { FamilySharingService } from '../services/family-sharing.service';
import { DbService } from '@/db/db.service';
import { DomainConflictException, DomainNotFoundException } from '@/common/errors/business.exception';

/**
 * BE-36 — PremiumConsumerService unit tests.
 *
 * Covers:
 *   - Happy-path subscribe flow
 *   - Duplicate subscription rejection (409)
 *   - Cancel flow with mandate disable
 *   - Cancel triggers family sharing revoke
 *   - Cancel when no active subscription (404)
 */
describe('PremiumConsumerService', () => {
  let service: PremiumConsumerService;
  let subsRepo: jest.Mocked<SubscriptionsRepository>;
  let familySharing: jest.Mocked<FamilySharingService>;

  const userId = '11111111-1111-1111-1111-111111111111';
  const tenantId = '22222222-2222-2222-2222-222222222222';

  beforeEach(async () => {
    const mockSubsRepo = {
      findByTenant: jest.fn(),
      updateByTenant: jest.fn(),
    };

    const mockFamilySharing = {
      revokeAllDerivedFromPrimary: jest.fn(),
    };

    const mockDbService = {
      getDb: jest.fn().mockReturnValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PremiumConsumerService,
        { provide: SubscriptionsRepository, useValue: mockSubsRepo },
        { provide: FamilySharingService, useValue: mockFamilySharing },
        { provide: DbService, useValue: mockDbService },
      ],
    }).compile();

    service = module.get<PremiumConsumerService>(PremiumConsumerService);
    subsRepo = module.get(SubscriptionsRepository);
    familySharing = module.get(FamilySharingService);
  });

  describe('subscribe', () => {
    it('should subscribe successfully when no active premium_consumer subscription exists', async () => {
      const mockSub = {
        id: 'sub-1',
        tenantId,
        planCode: 'starter',
        status: 'active',
        metadata: {},
      };
      subsRepo.findByTenant.mockResolvedValue(mockSub as never);
      subsRepo.updateByTenant.mockResolvedValue({
        ...mockSub,
        id: 'sub-1',
        planCode: 'premium_consumer',
        status: 'active',
      } as never);

      const result = await service.subscribe(userId, tenantId, 'tok_test_123');

      expect(result).toHaveProperty('subscriptionId', 'sub-1');
      expect(result).toHaveProperty('tier', 'premium_consumer');
      expect(result).toHaveProperty('emandateReference');
      expect(result.emandateReference).toMatch(/^MNDT_/);
      expect(result).toHaveProperty('nextRenewalAt');
      expect(subsRepo.updateByTenant).toHaveBeenCalledWith(
        tenantId,
        expect.objectContaining({ planCode: 'premium_consumer', status: 'active' }),
      );
    });

    it('should reject subscribe when already on premium_consumer tier', async () => {
      subsRepo.findByTenant.mockResolvedValue({
        id: 'sub-1',
        tenantId,
        planCode: 'premium_consumer',
        status: 'active',
      } as never);

      await expect(service.subscribe(userId, tenantId, 'tok_test_123')).rejects.toThrow(
        DomainConflictException,
      );
    });

    it('should throw DomainNotFoundException when no existing subscription found', async () => {
      subsRepo.findByTenant.mockResolvedValue(null);

      await expect(service.subscribe(userId, tenantId, 'tok_test_123')).rejects.toThrow(
        DomainNotFoundException,
      );
    });
  });

  describe('cancel', () => {
    it('should cancel active premium_consumer subscription', async () => {
      const mockSub = {
        id: 'sub-1',
        tenantId,
        planCode: 'premium_consumer',
        status: 'active',
        currentPeriodEnd: new Date('2025-02-15'),
        metadata: { emandateReference: 'MNDT_123' },
      };
      subsRepo.findByTenant.mockResolvedValue(mockSub as never);
      subsRepo.updateByTenant.mockResolvedValue({ ...mockSub, cancelledAt: new Date() } as never);
      familySharing.revokeAllDerivedFromPrimary.mockResolvedValue(undefined);

      const result = await service.cancel(userId, tenantId);

      expect(result).toHaveProperty('cancelledAt');
      expect(result).toHaveProperty('activeUntil');
      expect(result.activeUntil).toEqual(new Date('2025-02-15'));
      expect(familySharing.revokeAllDerivedFromPrimary).toHaveBeenCalledWith(userId);
      expect(subsRepo.updateByTenant).toHaveBeenCalledWith(
        tenantId,
        expect.objectContaining({ cancelledAt: expect.any(Date), status: 'cancelled' }),
      );
    });

    it('should throw DomainNotFoundException when no active premium_consumer subscription', async () => {
      subsRepo.findByTenant.mockResolvedValue({
        id: 'sub-1',
        tenantId,
        planCode: 'starter',
        status: 'active',
      } as never);

      await expect(service.cancel(userId, tenantId)).rejects.toThrow(DomainNotFoundException);
    });

    it('should throw DomainNotFoundException when subscription is already cancelled', async () => {
      subsRepo.findByTenant.mockResolvedValue({
        id: 'sub-1',
        tenantId,
        planCode: 'premium_consumer',
        status: 'cancelled',
      } as never);

      await expect(service.cancel(userId, tenantId)).rejects.toThrow(DomainNotFoundException);
    });
  });
});
