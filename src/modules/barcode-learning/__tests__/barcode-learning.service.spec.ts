import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import type { BarcodeLearningSubmissionRow } from '@/db/schema/barcode-learning';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  PRODUCTS_CATALOG_PORT,
  ProductsCatalogPort,
} from '../ports/products-catalog.port';
import { FlagRepository } from '../repositories/flag.repository';
import { SubmissionRepository } from '../repositories/submission.repository';
import {
  BarcodeLearningService,
  MAX_SUBMISSIONS_PER_DAY,
} from '../services/barcode-learning.service';
import { FlagTrackerService } from '../services/flag-tracker.service';

/**
 * BE-56 — `BarcodeLearningService` unit tests.
 *
 * Covers the consumer submission rate-limit, the moderator
 * approve/reject conflict guards, the catalog port contract on
 * approve, and flag insert + threshold delegation.
 */
describe('BarcodeLearningService', () => {
  let service: BarcodeLearningService;
  let submissions: jest.Mocked<SubmissionRepository>;
  let flags: jest.Mocked<FlagRepository>;
  let flagTracker: jest.Mocked<FlagTrackerService>;
  let catalog: jest.Mocked<ProductsCatalogPort>;
  let logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let audit: { logAction: jest.Mock };

  const userId = '11111111-1111-1111-1111-111111111111';
  const moderatorId = '22222222-2222-2222-2222-222222222222';
  const submissionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  const makeRow = (
    overrides: Partial<BarcodeLearningSubmissionRow> = {},
  ): BarcodeLearningSubmissionRow => ({
    id: submissionId,
    submitterUserId: userId,
    ean: '8901234567890',
    brand: null,
    name: null,
    category: null,
    s3ObjectKeys: null,
    status: 'pending',
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    moderatedAt: null,
    moderatedBy: null,
    moderationNotes: null,
    ...overrides,
  });

  beforeEach(async () => {
    const submissionsMock: jest.Mocked<SubmissionRepository> = {
      create: jest.fn(),
      findById: jest.fn(),
      listByStatus: jest.fn(),
      countByStatus: jest.fn(),
      updateStatus: jest.fn(),
      findLatestApprovedByEan: jest.fn(),
      countByUserSince: jest.fn(),
    } as unknown as jest.Mocked<SubmissionRepository>;

    const flagsMock: jest.Mocked<FlagRepository> = {
      create: jest.fn(),
      countUniqueByEan: jest.fn(),
    } as unknown as jest.Mocked<FlagRepository>;

    const flagTrackerMock = {
      evaluate: jest.fn(),
    } as unknown as jest.Mocked<FlagTrackerService>;

    const catalogMock: jest.Mocked<ProductsCatalogPort> = {
      upsertGlobal: jest.fn(),
    };

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    audit = { logAction: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BarcodeLearningService,
        { provide: SubmissionRepository, useValue: submissionsMock },
        { provide: FlagRepository, useValue: flagsMock },
        { provide: FlagTrackerService, useValue: flagTrackerMock },
        { provide: PRODUCTS_CATALOG_PORT, useValue: catalogMock },
        { provide: LoggerService, useValue: logger },
        { provide: AuditLogService, useValue: audit },
      ],
    }).compile();

    service = module.get(BarcodeLearningService);
    submissions = module.get(SubmissionRepository);
    flags = module.get(FlagRepository);
    flagTracker = module.get(FlagTrackerService);
    catalog = module.get(PRODUCTS_CATALOG_PORT);
  });

  describe('submit', () => {
    it('inserts a row and writes an audit entry on the happy path', async () => {
      submissions.countByUserSince.mockResolvedValue(0);
      const inserted = makeRow({ ean: '8901234567890', name: 'Atta' });
      submissions.create.mockResolvedValue(inserted);

      const result = await service.submit(userId, {
        ean: '8901234567890',
        name: 'Atta',
        s3ObjectKeys: ['key-1'],
      });

      expect(submissions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          submitterUserId: userId,
          ean: '8901234567890',
          name: 'Atta',
          s3ObjectKeys: ['key-1'],
        }),
      );
      expect(result.id).toBe(submissionId);
      expect(result.status).toBe('pending');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'barcode_learning_submission',
          resourceId: submissionId,
          userId,
          success: true,
          metadata: expect.objectContaining({ ean: '8901234567890', hasImages: true }),
        }),
      );
    });

    it('rejects submissions over the daily rate limit with ConflictException', async () => {
      submissions.countByUserSince.mockResolvedValue(MAX_SUBMISSIONS_PER_DAY);

      await expect(
        service.submit(userId, { ean: '8901234567890' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(submissions.create).not.toHaveBeenCalled();
      expect(audit.logAction).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('upserts to the catalog port, transitions status, and writes an audit log', async () => {
      const pending = makeRow({ status: 'pending', brand: 'Tata', name: 'Salt' });
      submissions.findById.mockResolvedValue(pending);
      catalog.upsertGlobal.mockResolvedValue({
        productId: 'prod-1',
        created: true,
      });
      submissions.updateStatus.mockResolvedValue(
        makeRow({
          status: 'approved',
          moderatedBy: moderatorId,
          moderatedAt: new Date('2025-01-02T00:00:00Z'),
          moderationNotes: 'looks good',
          brand: 'Tata',
          name: 'Salt',
        }),
      );

      const result = await service.approve(submissionId, moderatorId, {
        notes: 'looks good',
      });

      expect(catalog.upsertGlobal).toHaveBeenCalledWith(
        expect.objectContaining({
          ean: pending.ean,
          brand: 'Tata',
          name: 'Salt',
          source: 'community',
          submitterUserId: pending.submitterUserId,
          approvedBy: moderatorId,
        }),
      );
      expect(submissions.updateStatus).toHaveBeenCalledWith(
        submissionId,
        expect.objectContaining({
          status: 'approved',
          moderatedBy: moderatorId,
          moderationNotes: 'looks good',
        }),
      );
      expect(result.productId).toBe('prod-1');
      expect(result.catalogCreated).toBe(true);
      expect(result.submission.status).toBe('approved');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'barcode_learning_submission',
          metadata: expect.objectContaining({ outcome: 'approved', productId: 'prod-1' }),
        }),
      );
    });

    it('throws ConflictException when the submission is already approved', async () => {
      submissions.findById.mockResolvedValue(makeRow({ status: 'approved' }));

      await expect(service.approve(submissionId, moderatorId, {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(catalog.upsertGlobal).not.toHaveBeenCalled();
      expect(submissions.updateStatus).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the submission does not exist', async () => {
      submissions.findById.mockResolvedValue(null);

      await expect(service.approve(submissionId, moderatorId, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(catalog.upsertGlobal).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('sets status=rejected, writes an audit log, and does not call the catalog', async () => {
      const pending = makeRow({ status: 'pending' });
      submissions.findById.mockResolvedValue(pending);
      submissions.updateStatus.mockResolvedValue(
        makeRow({
          status: 'rejected',
          moderatedBy: moderatorId,
          moderatedAt: new Date('2025-01-03T00:00:00Z'),
          moderationNotes: 'duplicate of EAN 8901111111111',
        }),
      );

      const result = await service.reject(submissionId, moderatorId, {
        reason: 'duplicate of EAN 8901111111111',
      });

      expect(catalog.upsertGlobal).not.toHaveBeenCalled();
      expect(submissions.updateStatus).toHaveBeenCalledWith(
        submissionId,
        expect.objectContaining({
          status: 'rejected',
          moderatedBy: moderatorId,
          moderationNotes: 'duplicate of EAN 8901111111111',
        }),
      );
      expect(result.status).toBe('rejected');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          metadata: expect.objectContaining({ outcome: 'rejected' }),
        }),
      );
    });

    it('throws ConflictException when the submission is already rejected', async () => {
      submissions.findById.mockResolvedValue(makeRow({ status: 'rejected' }));

      await expect(
        service.reject(submissionId, moderatorId, { reason: 'reason text' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(submissions.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('flag', () => {
    it('inserts a fresh flag and asks the tracker to evaluate the threshold', async () => {
      flags.create.mockResolvedValue({
        id: 'flag-1',
        productEan: '8901234567890',
        flaggerUserId: userId,
        reason: 'wrong brand',
        createdAt: new Date('2025-01-04T00:00:00Z'),
      });
      flagTracker.evaluate.mockResolvedValue({
        ean: '8901234567890',
        uniqueFlagCount: 1,
        thresholdCrossed: false,
        flippedSubmissionId: null,
      });

      const result = await service.flag(userId, '8901234567890', { reason: 'wrong brand' });

      expect(flags.create).toHaveBeenCalledWith({
        productEan: '8901234567890',
        flaggerUserId: userId,
        reason: 'wrong brand',
      });
      expect(flagTracker.evaluate).toHaveBeenCalledWith('8901234567890');
      expect(result).toEqual({
        ean: '8901234567890',
        uniqueFlagCount: 1,
        thresholdCrossed: false,
        flippedSubmissionId: null,
        duplicate: false,
      });
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'barcode_learning_flag',
          resourceId: '8901234567890',
        }),
      );
    });

    it('reports duplicate=true and skips the tracker + audit when the user already flagged the EAN', async () => {
      flags.create.mockResolvedValue(null);
      flags.countUniqueByEan.mockResolvedValue(2);

      const result = await service.flag(userId, '8901234567890', {});

      expect(flagTracker.evaluate).not.toHaveBeenCalled();
      expect(flags.countUniqueByEan).toHaveBeenCalledWith('8901234567890');
      expect(result.duplicate).toBe(true);
      expect(result.uniqueFlagCount).toBe(2);
      expect(result.thresholdCrossed).toBe(false);
      expect(audit.logAction).not.toHaveBeenCalled();
    });
  });
});
