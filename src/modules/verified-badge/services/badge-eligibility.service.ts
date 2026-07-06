import { Injectable } from '@nestjs/common';

import type { OhsScoreEntry } from '../ports/ohs-source.port';

/**
 * BE-52 — eligibility / revocation thresholds.
 *
 * Issuance: 30 consecutive daily OHS totals at or above 75.
 * Revocation: the most recent 7 daily OHS totals all below 70.
 *
 * Both checks are evaluated on the same input (the last 30 daily
 * scores ordered ascending by `date`). We deliberately keep the
 * thresholds in one place so the cron, the unit tests, and the
 * design doc all agree on the numbers.
 */
export const ISSUE_THRESHOLD = 75;
export const REVOKE_THRESHOLD = 70;
export const ISSUE_STREAK_DAYS = 30;
export const REVOKE_STREAK_DAYS = 7;
export const REVOKE_REASON = 'OHS below 70 for 7 days';

export interface EligibilityResult {
  eligible: boolean;
  /** The most recent total in the input window, or null when the window was empty. */
  lastScore: number | null;
}

@Injectable()
export class BadgeEligibilityService {
  /**
   * Check whether the tenant is eligible for issuance.
   *
   * The window must contain *at least* 30 entries — otherwise we
   * don't have enough history to declare a consecutive streak. Every
   * entry must be >= 75. Returns the most recent score (last entry
   * in the ascending-ordered list) so the cron can persist it.
   */
  evaluateIssue(scores: OhsScoreEntry[]): EligibilityResult {
    if (scores.length < ISSUE_STREAK_DAYS) {
      return { eligible: false, lastScore: this.lastScore(scores) };
    }
    // Inspect the most recent ISSUE_STREAK_DAYS entries — if the
    // caller gave us more we still only require the streak to hold
    // over the latest window.
    const window = scores.slice(-ISSUE_STREAK_DAYS);
    const eligible = window.every((s) => s.total >= ISSUE_THRESHOLD);
    return { eligible, lastScore: this.lastScore(scores) };
  }

  /**
   * Check whether the tenant should have an existing badge revoked.
   *
   * Looks at the trailing 7 entries; every one of them must be
   * < 70 *and* the window must actually contain 7 days. A tenant
   * with fewer than 7 daily scores hasn't accrued enough history
   * to fail the threshold yet (defensive — should never happen
   * for a Pro tenant whose badge was issued earlier).
   */
  evaluateRevoke(scores: OhsScoreEntry[]): EligibilityResult {
    if (scores.length < REVOKE_STREAK_DAYS) {
      return { eligible: false, lastScore: this.lastScore(scores) };
    }
    const window = scores.slice(-REVOKE_STREAK_DAYS);
    const eligible = window.every((s) => s.total < REVOKE_THRESHOLD);
    return { eligible, lastScore: this.lastScore(scores) };
  }

  private lastScore(scores: OhsScoreEntry[]): number | null {
    if (scores.length === 0) return null;
    return scores[scores.length - 1].total;
  }
}
