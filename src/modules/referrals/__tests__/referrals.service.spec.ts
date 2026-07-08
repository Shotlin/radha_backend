import { DomainNotFoundException } from '@/common/errors/business.exception';
import type { LoggerService } from '@/logging/logger.service';
import type { AuditLogService } from '@/observability/audit-log.service';

import type { ReferralsRepository } from '../referrals.repository';
import { ReferralsService } from '../referrals.service';

interface MockRepo {
  findUserByReferralCode: jest.Mock;
  findReferralMetaByUserId: jest.Mock;
  setReferralCode: jest.Mock;
  setReferredBy: jest.Mock;
  createReward: jest.Mock;
  countRewardsForUser: jest.Mock;
  listRewardsForUser: jest.Mock;
  countInviteesForUser: jest.Mock;
}

const buildRepo = (): MockRepo => ({
  findUserByReferralCode: jest.fn(),
  findReferralMetaByUserId: jest.fn(),
  setReferralCode: jest.fn(),
  setReferredBy: jest.fn(),
  createReward: jest.fn(),
  countRewardsForUser: jest.fn(),
  listRewardsForUser: jest.fn(),
  countInviteesForUser: jest.fn(),
});

const buildAudit = (): AuditLogService =>
  ({ logAction: jest.fn(async () => undefined) }) as unknown as AuditLogService;

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const makeService = (
  overrides: Partial<MockRepo> = {},
): {
  service: ReferralsService;
  repo: MockRepo;
  audit: AuditLogService;
  logger: LoggerService;
} => {
  const repo: MockRepo = { ...buildRepo(), ...overrides };
  const audit = buildAudit();
  const logger = buildLogger();
  const service = new ReferralsService(repo as unknown as ReferralsRepository, audit, logger);
  return { service, repo, audit, logger };
};

describe('ReferralsService', () => {
  describe('getMyReferralSummary', () => {
    it('returns the existing code, counters, and recent rewards', async () => {
      const { service, repo } = makeService();
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'user-1',
        referralCode: 'ABCD2345',
        referredByUserId: null,
      });
      repo.countInviteesForUser.mockResolvedValue(2);
      repo.countRewardsForUser.mockResolvedValue(3);
      const grantedAt = new Date('2024-05-01T00:00:00Z');
      repo.listRewardsForUser.mockResolvedValue([
        {
          id: 'reward-1',
          userId: 'user-1',
          sourceReferralUserId: 'user-2',
          rewardType: 'premium_consumer_month',
          grantedAt,
        },
      ]);

      const result = await service.getMyReferralSummary('user-1');

      expect(result).toEqual({
        code: 'ABCD2345',
        totalReferrals: 2,
        rewardsEarned: 3,
        recentRewards: [
          {
            id: 'reward-1',
            sourceReferralUserId: 'user-2',
            rewardType: 'premium_consumer_month',
            grantedAt: grantedAt.toISOString(),
          },
        ],
      });
    });

    it('lazily generates a code when none exists', async () => {
      const { service, repo } = makeService();
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'user-1',
        referralCode: null,
        referredByUserId: null,
      });
      repo.findUserByReferralCode.mockResolvedValue(null);
      repo.setReferralCode.mockResolvedValue({ id: 'user-1' });
      repo.countInviteesForUser.mockResolvedValue(0);
      repo.countRewardsForUser.mockResolvedValue(0);
      repo.listRewardsForUser.mockResolvedValue([]);

      const result = await service.getMyReferralSummary('user-1');

      expect(result.code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
      expect(repo.setReferralCode).toHaveBeenCalledWith('user-1', result.code);
    });

    it('retries code generation on collision until a unique value persists', async () => {
      const { service, repo } = makeService();
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'user-1',
        referralCode: null,
        referredByUserId: null,
      });
      // First two probes hit existing rows, third is unique.
      repo.findUserByReferralCode
        .mockResolvedValueOnce({ id: 'other-1', referralCode: 'XX', tenantId: null })
        .mockResolvedValueOnce({ id: 'other-2', referralCode: 'YY', tenantId: null })
        .mockResolvedValueOnce(null);
      repo.setReferralCode.mockResolvedValue({ id: 'user-1' });
      repo.countInviteesForUser.mockResolvedValue(0);
      repo.countRewardsForUser.mockResolvedValue(0);
      repo.listRewardsForUser.mockResolvedValue([]);

      const result = await service.getMyReferralSummary('user-1');

      expect(repo.findUserByReferralCode).toHaveBeenCalledTimes(3);
      expect(repo.setReferralCode).toHaveBeenCalledTimes(1);
      expect(result.code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
    });

    it('throws DomainNotFoundException when the user does not exist', async () => {
      const { service, repo } = makeService();
      repo.findReferralMetaByUserId.mockResolvedValue(null);

      await expect(service.getMyReferralSummary('missing')).rejects.toBeInstanceOf(
        DomainNotFoundException,
      );
    });
  });

  describe('applyReferralOnSignup', () => {
    const inviter = { id: 'inviter-1', referralCode: 'INVITER1', tenantId: null };

    it('grants 1 month premium to BOTH inviter and invitee on success', async () => {
      const { service, repo, audit } = makeService();
      repo.findUserByReferralCode.mockResolvedValue(inviter);
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'invitee-1',
        referralCode: null,
        referredByUserId: null,
      });
      repo.setReferredBy.mockResolvedValue(true);
      repo.createReward
        .mockResolvedValueOnce({
          id: 'reward-1',
          userId: 'inviter-1',
          sourceReferralUserId: 'invitee-1',
          rewardType: 'premium_consumer_month',
          grantedAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 'reward-2',
          userId: 'invitee-1',
          sourceReferralUserId: 'inviter-1',
          rewardType: 'premium_consumer_month',
          grantedAt: new Date(),
        });

      const result = await service.applyReferralOnSignup('invitee-1', 'INVITER1');

      expect(result).toEqual({ applied: true });
      expect(repo.setReferredBy).toHaveBeenCalledWith('invitee-1', 'inviter-1');
      expect(repo.createReward).toHaveBeenNthCalledWith(1, {
        userId: 'inviter-1',
        sourceReferralUserId: 'invitee-1',
        rewardType: 'premium_consumer_month',
      });
      expect(repo.createReward).toHaveBeenNthCalledWith(2, {
        userId: 'invitee-1',
        sourceReferralUserId: 'inviter-1',
        rewardType: 'premium_consumer_month',
      });
      expect(audit.logAction).toHaveBeenCalledTimes(2);
    });

    it('silently rejects an empty code', async () => {
      const { service, repo } = makeService();

      const result = await service.applyReferralOnSignup('invitee-1', '');

      expect(result).toEqual({ applied: false, reason: 'empty_code' });
      expect(repo.findUserByReferralCode).not.toHaveBeenCalled();
    });

    it('silently rejects a null/undefined code', async () => {
      const { service, repo } = makeService();

      await expect(service.applyReferralOnSignup('invitee-1', null)).resolves.toEqual({
        applied: false,
        reason: 'empty_code',
      });
      await expect(service.applyReferralOnSignup('invitee-1', undefined)).resolves.toEqual({
        applied: false,
        reason: 'empty_code',
      });
      expect(repo.findUserByReferralCode).not.toHaveBeenCalled();
    });

    it('silently rejects a malformed code without hitting the DB', async () => {
      const { service, repo } = makeService();

      const result = await service.applyReferralOnSignup('invitee-1', 'short');

      expect(result).toEqual({ applied: false, reason: 'malformed_code' });
      expect(repo.findUserByReferralCode).not.toHaveBeenCalled();
    });

    it('silently rejects an unknown code', async () => {
      const { service, repo } = makeService();
      repo.findUserByReferralCode.mockResolvedValue(null);

      const result = await service.applyReferralOnSignup('invitee-1', 'NOTACODE');

      expect(result).toEqual({ applied: false, reason: 'unknown_code' });
      expect(repo.setReferredBy).not.toHaveBeenCalled();
      expect(repo.createReward).not.toHaveBeenCalled();
    });

    it('silently rejects a self-referral', async () => {
      const { service, repo, audit } = makeService();
      repo.findUserByReferralCode.mockResolvedValue({
        id: 'invitee-1',
        referralCode: 'SELF1234',
        tenantId: null,
      });

      const result = await service.applyReferralOnSignup('invitee-1', 'SELF1234');

      expect(result).toEqual({ applied: false, reason: 'self_referral' });
      expect(repo.setReferredBy).not.toHaveBeenCalled();
      expect(repo.createReward).not.toHaveBeenCalled();
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('rejects when the invitee already has a referrer (no double-grant)', async () => {
      const { service, repo } = makeService();
      repo.findUserByReferralCode.mockResolvedValue(inviter);
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'invitee-1',
        referralCode: null,
        referredByUserId: 'someone-else',
      });

      const result = await service.applyReferralOnSignup('invitee-1', 'INVITER1');

      expect(result).toEqual({ applied: false, reason: 'already_claimed' });
      expect(repo.setReferredBy).not.toHaveBeenCalled();
      expect(repo.createReward).not.toHaveBeenCalled();
    });

    it('treats a lost setReferredBy race as already_claimed', async () => {
      const { service, repo } = makeService();
      repo.findUserByReferralCode.mockResolvedValue(inviter);
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'invitee-1',
        referralCode: null,
        referredByUserId: null,
      });
      repo.setReferredBy.mockResolvedValue(false);

      const result = await service.applyReferralOnSignup('invitee-1', 'INVITER1');

      expect(result).toEqual({ applied: false, reason: 'already_claimed' });
      expect(repo.createReward).not.toHaveBeenCalled();
    });

    it('is idempotent — repeat reward inserts produce no audit noise', async () => {
      const { service, repo, audit } = makeService();
      repo.findUserByReferralCode.mockResolvedValue(inviter);
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'invitee-1',
        referralCode: null,
        referredByUserId: null,
      });
      repo.setReferredBy.mockResolvedValue(true);
      // Both onConflictDoNothing inserts return null (already existed).
      repo.createReward.mockResolvedValue(null);

      const result = await service.applyReferralOnSignup('invitee-1', 'INVITER1');

      expect(result).toEqual({ applied: true });
      expect(repo.createReward).toHaveBeenCalledTimes(2);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('normalises lowercase/whitespace in the code before lookup', async () => {
      const { service, repo } = makeService();
      repo.findUserByReferralCode.mockResolvedValue(inviter);
      repo.findReferralMetaByUserId.mockResolvedValue({
        id: 'invitee-1',
        referralCode: null,
        referredByUserId: null,
      });
      repo.setReferredBy.mockResolvedValue(true);
      repo.createReward.mockResolvedValue({
        id: 'reward-x',
        userId: 'inviter-1',
        sourceReferralUserId: 'invitee-1',
        rewardType: 'premium_consumer_month',
        grantedAt: new Date(),
      });

      await service.applyReferralOnSignup('invitee-1', '  inviter1 ');

      expect(repo.findUserByReferralCode).toHaveBeenCalledWith('INVITER1');
    });

    it('throws when the new user does not exist', async () => {
      const { service, repo } = makeService();
      repo.findUserByReferralCode.mockResolvedValue(inviter);
      repo.findReferralMetaByUserId.mockResolvedValue(null);

      await expect(service.applyReferralOnSignup('invitee-1', 'INVITER1')).rejects.toBeInstanceOf(
        DomainNotFoundException,
      );
    });
  });
});
