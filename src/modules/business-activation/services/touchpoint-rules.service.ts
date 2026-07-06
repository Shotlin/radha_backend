import { Injectable } from '@nestjs/common';

import { TouchpointCounterService } from './touchpoint-counter.service';

/**
 * BE-35 — Touchpoint eligibility rules.
 *
 * Evaluates which business-activation touchpoints should be surfaced
 * to a given Consumer user based on their usage patterns. The day-7
 * push touchpoint is handled by the cron job, not this service.
 */
export interface TouchpointEligibility {
  /** True if user has 5+ lifetime scans (smart banner trigger) */
  banner5Scans: boolean;
  /** Always true for Consumer users without a business tenant */
  homeCard: boolean;
  /** True if user has 50+ scans in the current week */
  heavyScanWeekly: boolean;
  /** Always true for Consumer (profile CTA) */
  profileCta: boolean;
  /** True when user is at or above the save limit (about to hit 6th) */
  saveLimitPrompt: boolean;
}

@Injectable()
export class TouchpointRulesService {
  constructor(private readonly counter: TouchpointCounterService) {}

  async evaluate(userId: string): Promise<TouchpointEligibility> {
    const counts = await this.counter.snapshot(userId);

    return {
      banner5Scans: counts.totalScans >= 5,
      homeCard: true,
      heavyScanWeekly: counts.scansThisWeek >= 50,
      profileCta: true,
      saveLimitPrompt: counts.savedProducts >= 5,
    };
  }
}
