import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AllergenProfileRepository } from '../repositories/allergen-profile.repository';
import { AllergenMatcherService } from '../services/allergen-matcher.service';
import { AllergenProfileService } from '../services/allergen-profile.service';
import { AllergenEncryptionService } from '../services/encryption.service';

describe('AllergenProfileService', () => {
  let service: AllergenProfileService;
  let repo: jest.Mocked<AllergenProfileRepository>;
  let encryption: AllergenEncryptionService;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';

  const mockProfileRow = {
    id: '33333333-3333-3333-3333-333333333333',
    tenantId,
    userId,
    familyMemberUserId: null,
    displayNameEncrypted: '', // will be set in beforeEach
    ageBand: 'adult',
    allergyTags: ['peanut', 'milk'],
    conditionTags: ['diabetes'],
    isActive: true,
    deletedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    const mockRepo = {
      countByUser: jest.fn(),
      findById: jest.fn(),
      findByUser: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      setActive: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AllergenProfileService,
        AllergenEncryptionService,
        AllergenMatcherService,
        { provide: AllergenProfileRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get(AllergenProfileService);
    repo = module.get(AllergenProfileRepository);
    encryption = module.get(AllergenEncryptionService);

    // Set encrypted display name on mock row
    mockProfileRow.displayNameEncrypted = encryption.encrypt('Test User');
  });

  describe('create', () => {
    it('should create a profile successfully', async () => {
      repo.countByUser.mockResolvedValue(0);
      repo.create.mockResolvedValue(mockProfileRow as any);

      const result = await service.upsert(tenantId, userId, {
        displayName: 'Test User',
        ageBand: 'adult',
        allergyTags: ['peanut', 'milk'],
        conditionTags: ['diabetes'],
      }, 'free');

      expect(result.id).toBe(mockProfileRow.id);
      expect(result.displayName).toBe('Test User');
      expect(repo.create).toHaveBeenCalled();
    });

    it('should enforce free_consumer quota of 1 profile', async () => {
      repo.countByUser.mockResolvedValue(1);

      await expect(
        service.upsert(tenantId, userId, {
          displayName: 'Second Profile',
          ageBand: 'child',
          allergyTags: ['gluten'],
          conditionTags: [],
        }, 'free_consumer'),
      ).rejects.toThrow(ConflictException);
    });

    it('should enforce premium_consumer quota of 5 profiles', async () => {
      repo.countByUser.mockResolvedValue(5);

      await expect(
        service.upsert(tenantId, userId, {
          displayName: 'Sixth Profile',
          ageBand: 'senior',
          allergyTags: ['egg'],
          conditionTags: [],
        }, 'premium_consumer'),
      ).rejects.toThrow(ConflictException);
    });

    it('should allow up to 5 profiles for premium_consumer plan', async () => {
      repo.countByUser.mockResolvedValue(4);
      repo.create.mockResolvedValue(mockProfileRow as any);

      const result = await service.upsert(tenantId, userId, {
        displayName: 'Fifth Profile',
        ageBand: 'adolescent',
        allergyTags: ['soy'],
        conditionTags: [],
      }, 'premium_consumer');

      expect(result).toBeDefined();
      expect(repo.create).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update an existing profile', async () => {
      const updatedRow = { ...mockProfileRow, ageBand: 'senior' };
      updatedRow.displayNameEncrypted = encryption.encrypt('Updated Name');
      repo.findById.mockResolvedValue(mockProfileRow as any);
      repo.update.mockResolvedValue(updatedRow as any);

      const result = await service.upsert(tenantId, userId, {
        id: mockProfileRow.id,
        displayName: 'Updated Name',
        ageBand: 'senior',
        allergyTags: ['peanut'],
        conditionTags: [],
      }, 'free');

      expect(result.ageBand).toBe('senior');
      expect(repo.update).toHaveBeenCalled();
    });

    it('should throw NotFoundException when profile not found', async () => {
      repo.findById.mockResolvedValue(null as any);

      await expect(
        service.upsert(tenantId, userId, {
          id: 'nonexistent-id',
          displayName: 'Name',
          ageBand: 'adult',
          allergyTags: [],
          conditionTags: [],
        }, 'free'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listByUser', () => {
    it('should return decrypted profiles', async () => {
      repo.findByUser.mockResolvedValue([mockProfileRow as any]);

      const results = await service.listByUser(tenantId, userId);

      expect(results).toHaveLength(1);
      expect(results[0].displayName).toBe('Test User');
      expect(results[0].allergyTags).toEqual(['peanut', 'milk']);
    });
  });

  describe('delete', () => {
    it('should soft-delete a profile', async () => {
      repo.findById.mockResolvedValue(mockProfileRow as any);
      repo.softDelete.mockResolvedValue(mockProfileRow as any);

      const result = await service.delete(tenantId, userId, mockProfileRow.id);
      expect(result.success).toBe(true);
      expect(repo.softDelete).toHaveBeenCalledWith(mockProfileRow.id, tenantId);
    });

    it('should throw NotFoundException if profile does not belong to user', async () => {
      repo.findById.mockResolvedValue({ ...mockProfileRow, userId: 'other-user' } as any);

      await expect(service.delete(tenantId, userId, mockProfileRow.id))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('setActive', () => {
    it('should set a profile as active', async () => {
      repo.findById.mockResolvedValue(mockProfileRow as any);
      repo.setActive.mockResolvedValue(mockProfileRow as any);

      const result = await service.setActive(tenantId, userId, mockProfileRow.id);
      expect(result.isActive).toBe(true);
    });
  });

  describe('encryption round-trip', () => {
    it('should encrypt and decrypt display name correctly', () => {
      const plaintext = 'My Child Name';
      const encrypted = encryption.encrypt(plaintext);
      const decrypted = encryption.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
      expect(encrypted).not.toBe(plaintext);
    });

    it('should produce different ciphertexts for the same input (random IV)', () => {
      const plaintext = 'Same Name';
      const e1 = encryption.encrypt(plaintext);
      const e2 = encryption.encrypt(plaintext);
      expect(e1).not.toBe(e2);
      expect(encryption.decrypt(e1)).toBe(plaintext);
      expect(encryption.decrypt(e2)).toBe(plaintext);
    });
  });

  describe('getMaxProfiles', () => {
    it('should return 1 for free_consumer tier', () => {
      expect(service.getMaxProfiles('free_consumer')).toBe(1);
    });

    it('should return 5 for premium_consumer tier', () => {
      expect(service.getMaxProfiles('premium_consumer')).toBe(5);
    });

    it('should return 5 for growth tier', () => {
      expect(service.getMaxProfiles('growth')).toBe(5);
    });

    it('should default to 1 for unknown tier', () => {
      expect(service.getMaxProfiles('unknown')).toBe(1);
    });
  });
});
