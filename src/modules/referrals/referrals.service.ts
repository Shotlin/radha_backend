import { Injectable } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { ReferralRewardItem, ReferralSummaryDto } from './dto/referral-summary.dto';
import { ReferralsRepository } from './referrals.repository';
import {
  generateReferralCode,
  isWellFormedReferralCode,
  normaliseReferralCode,
} from './utils/referral-code.util';

/**
 * BE-43 — Referral Program service.
 *
 * Implements Req 42:
 *   - Every user has a unique 8-char alphanumeric referral code,
 *     generated lazily the first time it's read or applied.
 *   - `applyReferralOnSignup(newUserId, code)` grants a 1-month
 *     Premium Consumer reward to BOTH the inviter and the invitee.
 *   - Self-referrals and unknown codes are silently rejected so the
 *     mobile client can call this unconditionally during signup
 *     without surfacing scary "invalid code" errors when the field
 *     was left blank.
 *   - The grant is idempotent — re-running the same apply (e.g. on
 *     OTP retry) never double-grants.
 *
 * The reward type today is `premium_consumer_month`. The actual
 * subscription mutation (extending current_period_end by 30 days,
 * upgrading the tenant's tier, etc.) is delegated to BE-28 and lives
 * outside this module. Recording the reward row here is what triggers
 * that downstream entitlement work; until BE-28's reward-redemption
 * cron lands the row is the source of truth for "this user has X free
 * months banked".
 */

const RESOURCE = 'ReferralReward';
const REWARD_TYPE = 'premium_consumer_month';
const MAX_CODE_GENERATION_ATTEMPTS = 5;

@Injectable()
export class ReferralsService {
  constructor(
    private readonly repo: ReferralsRepository,
    private readonly audit: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  /* ─────────────────── Read ─────────────────── */

  /**
   * Return the caller's code + summary. Generates the code lazily on
   * first call so historical accounts produced before BE-43 don't all
   * need a backfill.
   */
  async getMyReferralSummary(userId: string): Promise<ReferralSummaryDto> {
    const meta = await this.repo.findReferralMetaByUserId(userId);
    if (!meta) {
      throw new DomainNotFoundException('User', userId);
    }

    const code = meta.referralCode ?? (await this.ensureCode(userId));

    const [totalReferrals, rewardsEarned, recentRows] = await Promise.all([
      this.repo.countInviteesForUser(userId),
      this.repo.countRewardsForUser(userId),
      this.repo.listRewardsForUser(userId, 10),
    ]);

    const recentRewards: ReferralRewardItem[] = recentRows.map((row) => ({
      id: row.id,
      sourceReferralUserId: row.sourceReferralUserId,
      rewardType: row.rewardType,
      grantedAt: row.grantedAt.toISOString(),
    }));

    return { code, totalReferrals, rewardsEarned, recentRewards };
  }

  /* ─────────────────── Apply ─────────────────── */

  /**
   * Called by the auth/signup flow (and exposed via
   * `POST /api/v1/referrals/apply`). Returns whether the code resulted
   * in a reward being granted — the mobile app uses this only for
   * analytics, never to decide whether to surface an error.
   *
   * Silent rejections (returns `{ applied: false }`):
   *   - empty / falsy code,
   *   - malformed code (wrong length / non-alphanumeric),
   *   - unknown code,
   *   - self-referral,
   *   - the invitee has already used a referral code in the past.
   */
  async applyReferralOnSignup(
    newUserId: string,
    rawCode: string | null | undefined,
  ): Promise<{ applied: boolean; reason?: string }> {
    if (!rawCode) return { applied: false, reason: 'empty_code' };

    const code = normaliseReferralCode(rawCode);
    if (!isWellFormedReferralCode(code)) {
      this.logger.info('referrals.apply.malformed_code', { newUserId });
      return { applied: false, reason: 'malformed_code' };
    }

    const inviter = await this.repo.findUserByReferralCode(code);
    if (!inviter) {
      this.logger.info('referrals.apply.unknown_code', { newUserId });
      return { applied: false, reason: 'unknown_code' };
    }

    if (inviter.id === newUserId) {
      this.logger.info('referrals.apply.self_referral_rejected', { newUserId });
      return { applied: false, reason: 'self_referral' };
    }

    const invitee = await this.repo.findReferralMetaByUserId(newUserId);
    if (!invitee) {
      throw new DomainNotFoundException('User', newUserId);
    }
    if (invitee.referredByUserId) {
      // Already claimed — keep the original attribution, no double reward.
      this.logger.info('referrals.apply.already_claimed', {
        newUserId,
        existingInviter: invitee.referredByUserId,
      });
      return { applied: false, reason: 'already_claimed' };
    }

    // Stamp the invitee's row first so a partial failure on the reward
    // insert never produces an "inviter linked but no rewards" gap.
    const linked = await this.repo.setReferredBy(newUserId, inviter.id);
    if (!linked) {
      // Lost the race to another concurrent apply for the same user.
      this.logger.info('referrals.apply.lost_race', { newUserId });
      return { applied: false, reason: 'already_claimed' };
    }

    await this.grantOneMonthPremium(inviter.id, newUserId);
    await this.grantOneMonthPremium(newUserId, inviter.id);

    this.logger.info('referrals.apply.success', {
      newUserId,
      inviterUserId: inviter.id,
    });

    return { applied: true };
  }

  /* ─────────────────── Internal helpers ─────────────────── */

  /**
   * Insert a reward row. Idempotent via the unique index — repeat
   * inserts with the same `(user_id, source_referral_user_id,
   * reward_type)` triple are silently absorbed and produce no audit
   * noise. Records an audit row only when a fresh grant lands.
   */
  private async grantOneMonthPremium(userId: string, sourceReferralUserId: string): Promise<void> {
    const row = await this.repo.createReward({
      userId,
      sourceReferralUserId,
      rewardType: REWARD_TYPE,
    });

    if (!row) return;

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: RESOURCE,
      resourceId: row.id,
      userId,
      tenantId: 'system',
      success: true,
      metadata: {
        rewardType: REWARD_TYPE,
        sourceReferralUserId,
      },
    });
  }

  /**
   * Generate and persist a unique referral code for a user. Retries
   * on the unique-index race condition. Returns the persisted code.
   */
  private async ensureCode(userId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = generateReferralCode();
      const collision = await this.repo.findUserByReferralCode(candidate);
      if (collision) continue;
      try {
        const updated = await this.repo.setReferralCode(userId, candidate);
        if (!updated) {
          throw new DomainNotFoundException('User', userId);
        }
        this.logger.info('referrals.code.generated', { userId });
        return candidate;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === '23505') {
          // Unique violation — another generator beat us. Retry.
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `Failed to generate a unique referral code for user ${userId} after ${MAX_CODE_GENERATION_ATTEMPTS} attempts`,
    );
  }
}
