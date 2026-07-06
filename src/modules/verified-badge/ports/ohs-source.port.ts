import { Injectable } from '@nestjs/common';

/**
 * BE-52 — port for OHS score lookup.
 *
 * The verified-badge cron only needs a thin slice of the OHS history:
 * the last 30 days of total scores per tenant. The badge module
 * deliberately does not import the BE-30 health-scoring repository
 * directly — that module ships per-store rows and the badge logic is
 * tenant-level (per the BE-52 brief, "multi-store handling: per
 * tenant, not per store").
 *
 * BE-30 v2 will expose its own implementation that aggregates store
 * rows into a single tenant-level total. Until then the default
 * `StubOhsSourceAdapter` returns 30 days of mock 75-point scores so
 * the rest of the pipeline (eligibility, issue, audit, verify) can be
 * exercised end-to-end.
 *
 * Each entry is a *daily* observation, ordered oldest-first. The
 * eligibility service relies on this ordering — if you switch to a
 * persistence-backed adapter, sort by date ascending before returning.
 */
export interface OhsScoreEntry {
  /** ISO date (YYYY-MM-DD) the score was computed for. */
  date: string;
  /** Total OHS in the [0, 100] range. */
  total: number;
}

export interface IOhsSourcePort {
  /**
   * Return the last 30 daily OHS observations for the tenant,
   * ordered ascending by `date`. Fewer than 30 entries means the
   * tenant has not yet accrued enough history (eligibility cannot
   * be granted).
   */
  last30Days(tenantId: string): Promise<OhsScoreEntry[]>;
}

export const OHS_SOURCE_PORT = Symbol('OHS_SOURCE_PORT');

/**
 * Default no-op stub.
 *
 * Returns a flat 30-day band at score 75 — the minimum issue
 * threshold — so the pipeline issues a badge during smoke tests
 * without hand-rolling fixtures. Replace with a BE-30-backed
 * adapter in BE-52 v2.
 */
@Injectable()
export class StubOhsSourceAdapter implements IOhsSourcePort {
  async last30Days(_tenantId: string): Promise<OhsScoreEntry[]> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const out: OhsScoreEntry[] = [];
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      out.push({
        date: d.toISOString().slice(0, 10),
        total: 75,
      });
    }
    return out;
  }
}
