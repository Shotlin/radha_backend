import { Injectable } from '@nestjs/common';

import type { WeeklyDigestTopProduct } from '../dto/weekly-digest.dto';

/**
 * BE-54 — Scans/analytics source port.
 *
 * The weekly digest is computed from data owned by upstream
 * modules (BE-16 scans, BE-37 saved-products, BE-39 recall
 * alerts, BE-40 alternatives). To keep this module testable in
 * isolation we don't import those repositories directly — we
 * declare a narrow port and let `WeeklyDigestModule` wire a
 * concrete adapter at boot time.
 *
 * The default `StubScansSourceAdapter` returns zeros. The real
 * adapter lives outside this module (BE-29 analytics owns it) and
 * is registered against the `SCANS_SOURCE_TOKEN` provider.
 */
export interface WeeklyScanStats {
  scansCount: number;
  highSugarCount: number;
  recallCount: number;
  alternativesRecommended: number;
  /** Top scanned products in the window. May be empty. */
  topProducts: WeeklyDigestTopProduct[];
  /** Estimated savings (₹) from suggested alternatives. */
  savings: number;
}

/**
 * Port contract. Adapters implement this to feed the digest with
 * real data from scans + alerts + alternatives tables.
 */
export interface IScansSourcePort {
  /**
   * Compute weekly stats for one consumer over the half-open
   * window `[weekStartingUtc, weekEndingUtc)`.
   *
   * Returning zero counts is valid — the service still records a
   * row so the consumer can see "you did not scan anything this
   * week" if we choose to surface that on the Mobile_App.
   */
  getWeeklyStats(
    userId: string,
    weekStartingUtc: Date,
    weekEndingUtc: Date,
  ): Promise<WeeklyScanStats>;
}

/** DI token. Service injects via `@Inject(SCANS_SOURCE_TOKEN)`. */
export const SCANS_SOURCE_TOKEN = Symbol('WEEKLY_DIGEST_SCANS_SOURCE');

/**
 * Default zero-stats adapter shipped with the module.
 *
 * Used when no concrete adapter is wired (e.g. in early phases
 * before BE-29 analytics is plumbed). Keeps the cron functional —
 * digest rows are created with zero counts and the consumer still
 * receives the FCM message.
 */
@Injectable()
export class StubScansSourceAdapter implements IScansSourcePort {
  async getWeeklyStats(
    _userId: string,
    _weekStartingUtc: Date,
    _weekEndingUtc: Date,
  ): Promise<WeeklyScanStats> {
    return {
      scansCount: 0,
      highSugarCount: 0,
      recallCount: 0,
      alternativesRecommended: 0,
      topProducts: [],
      savings: 0,
    };
  }
}
