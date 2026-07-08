import type { OhsScoreEntry } from '../ports/ohs-source.port';
import {
  BadgeEligibilityService,
  ISSUE_STREAK_DAYS,
  ISSUE_THRESHOLD,
  REVOKE_STREAK_DAYS,
  REVOKE_THRESHOLD,
} from '../services/badge-eligibility.service';

const day = (i: number, total: number): OhsScoreEntry => {
  const d = new Date('2025-01-01T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), total };
};

describe('BadgeEligibilityService', () => {
  let svc: BadgeEligibilityService;

  beforeEach(() => {
    svc = new BadgeEligibilityService();
  });

  describe('evaluateIssue', () => {
    it('is eligible when 30 consecutive days are >= 75', () => {
      const scores = Array.from({ length: ISSUE_STREAK_DAYS }, (_, i) => day(i, ISSUE_THRESHOLD));
      const result = svc.evaluateIssue(scores);
      expect(result.eligible).toBe(true);
      expect(result.lastScore).toBe(ISSUE_THRESHOLD);
    });

    it('is eligible when all 30 days are well above the threshold', () => {
      const scores = Array.from({ length: ISSUE_STREAK_DAYS }, (_, i) => day(i, 92));
      const result = svc.evaluateIssue(scores);
      expect(result.eligible).toBe(true);
      expect(result.lastScore).toBe(92);
    });

    it('is NOT eligible when the input has fewer than 30 days', () => {
      const scores = Array.from({ length: 29 }, (_, i) => day(i, 90));
      const result = svc.evaluateIssue(scores);
      expect(result.eligible).toBe(false);
      expect(result.lastScore).toBe(90);
    });

    it('is NOT eligible when any day in the latest 30-day window is below 75', () => {
      const scores = Array.from({ length: ISSUE_STREAK_DAYS }, (_, i) => day(i, 80));
      // Drop one day in the middle to 74.
      scores[15] = day(15, 74);
      const result = svc.evaluateIssue(scores);
      expect(result.eligible).toBe(false);
      expect(result.lastScore).toBe(80);
    });

    it('only inspects the most recent 30 days when more are supplied', () => {
      // 35 days where the oldest 5 are below threshold but the
      // latest 30 are not — issuance should still pass.
      const scores = [
        ...Array.from({ length: 5 }, (_, i) => day(i, 50)),
        ...Array.from({ length: ISSUE_STREAK_DAYS }, (_, i) => day(5 + i, 80)),
      ];
      const result = svc.evaluateIssue(scores);
      expect(result.eligible).toBe(true);
    });

    it('is NOT eligible when an empty input is passed', () => {
      const result = svc.evaluateIssue([]);
      expect(result.eligible).toBe(false);
      expect(result.lastScore).toBeNull();
    });
  });

  describe('evaluateRevoke', () => {
    it('is eligible when the latest 7 days are all below 70', () => {
      const scores = Array.from({ length: 30 }, (_, i) => day(i, 80));
      // Last 7 days drop below threshold.
      for (let i = 23; i < 30; i += 1) scores[i] = day(i, REVOKE_THRESHOLD - 1);
      const result = svc.evaluateRevoke(scores);
      expect(result.eligible).toBe(true);
      expect(result.lastScore).toBe(REVOKE_THRESHOLD - 1);
    });

    it('is NOT eligible when one of the latest 7 days is at or above 70', () => {
      const scores = Array.from({ length: 30 }, (_, i) => day(i, 60));
      scores[27] = day(27, REVOKE_THRESHOLD); // exactly 70 → NOT < 70
      const result = svc.evaluateRevoke(scores);
      expect(result.eligible).toBe(false);
    });

    it('is NOT eligible when fewer than 7 days are supplied', () => {
      const scores = Array.from({ length: REVOKE_STREAK_DAYS - 1 }, (_, i) => day(i, 50));
      const result = svc.evaluateRevoke(scores);
      expect(result.eligible).toBe(false);
    });

    it('is NOT eligible when prior days were healthy but only the most recent dropped', () => {
      const scores = Array.from({ length: 30 }, (_, i) => day(i, 80));
      scores[29] = day(29, 50);
      const result = svc.evaluateRevoke(scores);
      // Need the full 7-day streak below threshold; one day isn't enough.
      expect(result.eligible).toBe(false);
    });

    it('returns null lastScore for empty input', () => {
      const result = svc.evaluateRevoke([]);
      expect(result.eligible).toBe(false);
      expect(result.lastScore).toBeNull();
    });
  });
});
