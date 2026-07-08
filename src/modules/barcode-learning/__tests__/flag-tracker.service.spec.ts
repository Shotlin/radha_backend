import { Test, TestingModule } from '@nestjs/testing';

import type { BarcodeLearningSubmissionRow } from '@/db/schema/barcode-learning';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { FlagRepository } from '../repositories/flag.repository';
import { SubmissionRepository } from '../repositories/submission.repository';
import {
  FLAG_REMODERATION_THRESHOLD,
  FlagTrackerService,
} from '../services/flag-tracker.service';

/**
 * BE-56 — `FlagTrackerService` unit tests.
 *
 * Validates the threshold policy:
 *   - below threshold ⇒ no flip
 *   - at/over threshold + approved row ⇒ flip + audit log
 *   - at/over threshold + no approved row ⇒ warn, no flip
 *   - idempotent on subsequent runs
 *   - returns the unique flag count to the caller
 */
describe('FlagTrackerService', () => {
  let service: FlagTrackerService;
  let flags: jest.Mocked<FlagRepository>;
  let submissions: jest.Mocked<SubmissionRepository>;
  let logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let audit: { logAction: jest.Mock };

  const ean = '8901234567890';
  const submissionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  const makeApproved = (
    overrides: Partial<BarcodeLearningSubmissionRow> = {},
  ): BarcodeLearningSubmissionRow => ({
    id: submissionId,
    submitterUserId: '11111111-1111-1111-1111-111111111111',
    ean,
    brand: 'Tata',
    name: 'Salt',
    category: null,
    s3ObjectKeys: null,
    status: 'approved',
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    moderatedAt: new Date('2025-01-02T00:00:00Z'),
    moderatedBy: '22222222-2222-2222-2222-222222222222',
    moderationNotes: null,
    ...overrides,
  });

  beforeEach(async () => {
    const flagsMock: jest.Mocked<FlagRepository> = {
      create: jest.fn(),
      countUniqueByEan: jest.fn(),
    } as unknown as jest.Mocked<FlagRepository>;

    const submissionsMock: jest.Mocked<SubmissionRepository> = {
      create: jest.fn(),
      findById: jest.fn(),
      listByStatus: jest.fn(),
      countByStatus: jest.fn(),
      updateStatus: jest.fn(),
      findLatestApprovedByEan: jest.fn(),
      countByUserSince: jest.fn(),
    } as unknown as jest.Mocked<SubmissionRepository>;

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    audit = { logAction: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlagTrackerService,
        { provide: FlagRepository, useValue: flagsMock },
        { provide: SubmissionRepository, useValue: submissionsMock },
        { provide: LoggerService, useValue: logger },
        { provide: AuditLogService, useValue: audit },
      ],
    }).compile();

    service = module.get(FlagTrackerService);
    flags = module.get(FlagRepository);
    submissions = module.get(SubmissionRepository);
  });

  it('returns thresholdCrossed=false and does not flip when count is below the threshold', async () => {
    flags.countUniqueByEan.mockResolvedValue(FLAG_REMODERATION_THRESHOLD - 1);

    const result = await service.evaluate(ean);

    expect(result).toEqual({
      ean,
      uniqueFlagCount: FLAG_REMODERATION_THRESHOLD - 1,
      thresholdCrossed: false,
      flippedSubmissionId: null,
    });
    expect(submissions.findLatestApprovedByEan).not.toHaveBeenCalled();
    expect(submissions.updateStatus).not.toHaveBeenCalled();
    expect(audit.logAction).not.toHaveBeenCalled();
  });

  it('flips the latest approved submission to flagged and writes an audit log when the threshold is crossed', async () => {
    flags.countUniqueByEan.mockResolvedValue(FLAG_REMODERATION_THRESHOLD);
    submissions.findLatestApprovedByEan.mockResolvedValue(makeApproved());
    submissions.updateStatus.mockResolvedValue(makeApproved({ status: 'flagged' }));

    const result = await service.evaluate(ean);

    expect(submissions.updateStatus).toHaveBeenCalledWith(
      submissionId,
      expect.objectContaining({ status: 'flagged' }),
    );
    expect(result.thresholdCrossed).toBe(true);
    expect(result.flippedSubmissionId).toBe(submissionId);
    expect(result.uniqueFlagCount).toBe(FLAG_REMODERATION_THRESHOLD);
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'barcode_learning_submission',
        resourceId: submissionId,
        metadata: expect.objectContaining({
          reason: 'flag_threshold_crossed',
          ean,
          threshold: FLAG_REMODERATION_THRESHOLD,
        }),
      }),
    );
  });

  it('logs a warning and does not flip when the threshold is crossed but no approved submission exists', async () => {
    flags.countUniqueByEan.mockResolvedValue(FLAG_REMODERATION_THRESHOLD + 1);
    submissions.findLatestApprovedByEan.mockResolvedValue(null);

    const result = await service.evaluate(ean);

    expect(result.thresholdCrossed).toBe(true);
    expect(result.flippedSubmissionId).toBeNull();
    expect(submissions.updateStatus).not.toHaveBeenCalled();
    expect(audit.logAction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'barcode_learning.flag_threshold.no_approved_submission',
      expect.objectContaining({ ean }),
    );
  });

  it('is idempotent: a second run after the flip finds no approved row and is a no-op', async () => {
    flags.countUniqueByEan.mockResolvedValue(FLAG_REMODERATION_THRESHOLD);
    // First call: an approved row exists, gets flipped.
    submissions.findLatestApprovedByEan
      .mockResolvedValueOnce(makeApproved())
      // Second call: the row is now `flagged` and findLatestApprovedByEan
      // returns null because it filters on `status='approved'`.
      .mockResolvedValueOnce(null);
    submissions.updateStatus.mockResolvedValue(makeApproved({ status: 'flagged' }));

    const first = await service.evaluate(ean);
    const second = await service.evaluate(ean);

    expect(first.flippedSubmissionId).toBe(submissionId);
    expect(second.flippedSubmissionId).toBeNull();
    // updateStatus was only called for the first evaluation.
    expect(submissions.updateStatus).toHaveBeenCalledTimes(1);
    expect(audit.logAction).toHaveBeenCalledTimes(1);
  });

  it('returns the current uniqueFlagCount in the result', async () => {
    flags.countUniqueByEan.mockResolvedValue(7);
    submissions.findLatestApprovedByEan.mockResolvedValue(makeApproved());
    submissions.updateStatus.mockResolvedValue(makeApproved({ status: 'flagged' }));

    const result = await service.evaluate(ean);

    expect(result.uniqueFlagCount).toBe(7);
    expect(result.thresholdCrossed).toBe(true);
    expect(result.ean).toBe(ean);
  });
});
