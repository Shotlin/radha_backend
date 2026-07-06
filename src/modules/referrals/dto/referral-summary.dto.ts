/**
 * BE-43 — Response body for `GET /api/v1/referrals/me`.
 *
 * Returned by `ReferralsService.getMyReferralSummary`. Contains the
 * caller's own referral code plus aggregate counters that power the
 * "X friends joined / Y free months earned" panel in the mobile app.
 */
export interface ReferralRewardItem {
  /** Reward row id. */
  id: string;
  /** The opposite user — i.e. the inviter for invitee rewards and vice versa. */
  sourceReferralUserId: string;
  /** Reward kind, currently always `premium_consumer_month`. */
  rewardType: string;
  /** ISO8601 timestamp the reward was granted. */
  grantedAt: string;
}

export interface ReferralSummaryDto {
  /** The caller's unique 8-char referral code (auto-generated lazily). */
  code: string;
  /** Number of users who signed up using this code (= inviter rewards). */
  totalReferrals: number;
  /** Free-month rewards the caller has earned in total. */
  rewardsEarned: number;
  /** Most recent rewards (max 10). */
  recentRewards: ReferralRewardItem[];
}
