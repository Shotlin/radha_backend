import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { SavedProductRow } from '@/db/schema/saved-products';

import { ExpiryCalendarRepository } from '../expiry-calendar.repository';
import { FamilySharingRepository } from '../repositories/family-sharing-lookup.repository';
import { ExpiryCalendarService } from '../services/expiry-calendar.service';
import { EXPIRY_COLOR_THRESHOLDS } from '../types/expiry-calendar.types';

describe('ExpiryCalendarService', () => {
  let service: ExpiryCalendarService;
  let repo: jest.Mocked<ExpiryCalendarRepository>;
  let familyRepo: jest.Mocked<FamilySharingRepository>;

  const userId = '11111111-1111-1111-1111-111111111111';
  const familyMemberId = '22222222-2222-2222-2222-222222222222';

  const makeSavedProduct = (overrides: Partial<SavedProductRow> = {}): SavedProductRow => ({
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    userId,
    productName: 'Test Product',
    productId: null,
    barcode: null,
    expiresAt: '2025-02-15',
    markedConsumedAt: null,
    notes: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpiryCalendarService,
        {
          provide: ExpiryCalendarRepository,
          useValue: {
            findActiveByUserInRange: jest.fn().mockResolvedValue([]),
            findActiveByUsersInRange: jest.fn().mockResolvedValue([]),
            findActiveByUser: jest.fn().mockResolvedValue([]),
            countActiveByUser: jest.fn().mockResolvedValue(0),
            findByIdForUsers: jest.fn().mockResolvedValue(undefined),
            markConsumed: jest.fn().mockResolvedValue(undefined),
            remove: jest.fn().mockResolvedValue(false),
          },
        },
        {
          provide: FamilySharingRepository,
          useValue: {
            getAcceptedFamilyUserIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(ExpiryCalendarService);
    repo = module.get(ExpiryCalendarRepository);
    familyRepo = module.get(FamilySharingRepository);
  });

  describe('byMonth', () => {
    it('should return an empty calendar for a month with no products', async () => {
      const result = await service.byMonth(userId, '2025-02', false);

      expect(result.month).toBe('2025-02');
      expect(result.totalProducts).toBe(0);
      expect(result.days).toHaveLength(0);
      expect(result.summary).toEqual({ green: 0, yellow: 0, red: 0, expired: 0 });
    });

    it('should query user products only for free consumer', async () => {
      await service.byMonth(userId, '2025-02', false);

      expect(repo.findActiveByUserInRange).toHaveBeenCalledWith(userId, '2025-02-01', '2025-02-28');
      expect(repo.findActiveByUsersInRange).not.toHaveBeenCalled();
    });

    it('should query user + family members for premium consumer', async () => {
      familyRepo.getAcceptedFamilyUserIds.mockResolvedValue([familyMemberId]);

      await service.byMonth(userId, '2025-02', true);

      expect(repo.findActiveByUsersInRange).toHaveBeenCalledWith(
        [userId, familyMemberId],
        '2025-02-01',
        '2025-02-28',
      );
    });

    it('should calculate correct month range for months with 31 days', async () => {
      await service.byMonth(userId, '2025-01', false);
      expect(repo.findActiveByUserInRange).toHaveBeenCalledWith(userId, '2025-01-01', '2025-01-31');
    });

    it('should handle February in a leap year', async () => {
      await service.byMonth(userId, '2024-02', false);
      expect(repo.findActiveByUserInRange).toHaveBeenCalledWith(userId, '2024-02-01', '2024-02-29');
    });

    it('should group products by day and sort days chronologically', async () => {
      repo.findActiveByUserInRange.mockResolvedValue([
        makeSavedProduct({ id: 'a1', expiresAt: '2025-02-20', productName: 'Product A' }),
        makeSavedProduct({ id: 'a2', expiresAt: '2025-02-10', productName: 'Product B' }),
        makeSavedProduct({ id: 'a3', expiresAt: '2025-02-20', productName: 'Product C' }),
      ]);

      const result = await service.byMonth(userId, '2025-02', false);

      expect(result.days).toHaveLength(2);
      expect(result.days[0].date).toBe('2025-02-10');
      expect(result.days[0].count).toBe(1);
      expect(result.days[1].date).toBe('2025-02-20');
      expect(result.days[1].count).toBe(2);
      expect(result.totalProducts).toBe(3);
    });

    it('should not include products with null expiresAt in days', async () => {
      repo.findActiveByUserInRange.mockResolvedValue([
        makeSavedProduct({ id: 'a1', expiresAt: null as any }),
      ]);

      const result = await service.byMonth(userId, '2025-02', false);

      expect(result.days).toHaveLength(0);
    });

    it('should return correct response shape', async () => {
      repo.findActiveByUserInRange.mockResolvedValue([
        makeSavedProduct({ id: 'a1', expiresAt: '2025-02-15' }),
      ]);

      const result = await service.byMonth(userId, '2025-02', false);

      expect(result).toHaveProperty('month');
      expect(result).toHaveProperty('totalProducts');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('days');
      expect(result.summary).toHaveProperty('green');
      expect(result.summary).toHaveProperty('yellow');
      expect(result.summary).toHaveProperty('red');
      expect(result.summary).toHaveProperty('expired');

      const day = result.days[0];
      expect(day).toHaveProperty('date');
      expect(day).toHaveProperty('count');
      expect(day).toHaveProperty('dominantColor');
      expect(day).toHaveProperty('products');

      const product = day.products[0];
      expect(product).toHaveProperty('id');
      expect(product).toHaveProperty('productName');
      expect(product).toHaveProperty('expiresAt');
      expect(product).toHaveProperty('color');
      expect(product).toHaveProperty('daysUntilExpiry');
    });
  });

  describe('color coding', () => {
    it('should return red for products expiring in < 7 days', () => {
      expect(service.getColor(0)).toBe('red');
      expect(service.getColor(3)).toBe('red');
      expect(service.getColor(6)).toBe('red');
      expect(service.getColor(-1)).toBe('red'); // already expired
    });

    it('should return yellow for products expiring in 7–30 days', () => {
      expect(service.getColor(7)).toBe('yellow');
      expect(service.getColor(15)).toBe('yellow');
      expect(service.getColor(30)).toBe('yellow');
    });

    it('should return green for products expiring in > 30 days', () => {
      expect(service.getColor(31)).toBe('green');
      expect(service.getColor(60)).toBe('green');
      expect(service.getColor(365)).toBe('green');
    });

    it('should set dominantColor to the worst color on a day', async () => {
      // Spy on getTodayIST to fix the "today" date
      jest.spyOn(service, 'getTodayIST').mockReturnValue('2025-02-01');

      repo.findActiveByUserInRange.mockResolvedValue([
        makeSavedProduct({ id: 'a1', expiresAt: '2025-02-05' }), // 4 days = red
        makeSavedProduct({ id: 'a2', expiresAt: '2025-02-05' }), // 4 days = red
      ]);

      const result = await service.byMonth(userId, '2025-02', false);

      expect(result.days[0].dominantColor).toBe('red');
    });
  });

  describe('consumed products excluded', () => {
    it('should only query non-consumed products (repository handles filtering)', async () => {
      // The repository WHERE clause filters out markedConsumedAt IS NOT NULL
      await service.byMonth(userId, '2025-02', false);

      expect(repo.findActiveByUserInRange).toHaveBeenCalledWith(userId, '2025-02-01', '2025-02-28');
    });
  });

  describe('markConsumed', () => {
    it('should mark a product as consumed', async () => {
      const product = makeSavedProduct({ id: 'prod-1', userId });
      repo.findByIdForUsers.mockResolvedValue(product);
      repo.markConsumed.mockResolvedValue({
        ...product,
        markedConsumedAt: new Date('2025-02-10T10:00:00Z'),
      });

      const result = await service.markConsumed(userId, 'prod-1', false);

      expect(result.id).toBe('prod-1');
      expect(result.markedConsumedAt).toBe('2025-02-10T10:00:00.000Z');
    });

    it('should throw NotFoundException if product not found', async () => {
      repo.findByIdForUsers.mockResolvedValue(undefined);

      await expect(service.markConsumed(userId, 'nonexistent', false)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if product belongs to another user', async () => {
      const product = makeSavedProduct({ id: 'prod-1', userId: familyMemberId });
      repo.findByIdForUsers.mockResolvedValue(product);

      await expect(service.markConsumed(userId, 'prod-1', true)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('remove', () => {
    it('should remove a product', async () => {
      const product = makeSavedProduct({ id: 'prod-1', userId });
      repo.findByIdForUsers.mockResolvedValue(product);
      repo.remove.mockResolvedValue(true);

      const result = await service.remove(userId, 'prod-1', false);

      expect(result).toEqual({ id: 'prod-1', removed: true });
    });

    it('should throw NotFoundException if product not found', async () => {
      repo.findByIdForUsers.mockResolvedValue(undefined);

      await expect(service.remove(userId, 'nonexistent', false)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('IST timezone awareness', () => {
    it('should return a date string in YYYY-MM-DD format', () => {
      const today = service.getTodayIST();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
