/**
 * BE-39 — Recall module public types.
 *
 * `FeedEntryDraft` is the normalised shape every adapter produces.
 * Each upstream feed adapter (FSSAI, plus future MoFPI/CDSCO/state
 * regulator feeds) maps its raw payload into this shape so the
 * sweep service stays adapter-agnostic.
 */

export type RecallFeedSource = 'fssai' | string;

export interface FeedEntryDraft {
  /** Source slug — matches the column `recall_feed_entries.source`. */
  source: RecallFeedSource;
  ean: string | null;
  brand: string | null;
  productName: string | null;
  batchNumber: string | null;
  reason: string;
  /** ISO 8601 date string (YYYY-MM-DD) — coerced to `DATE`. */
  recalledAt: string;
  raw: Record<string, unknown>;
}

export interface SavedProductMatch {
  userId: string;
  tenantId: string;
  savedProductId: string;
}

export interface SweepReport {
  fetched: number;
  persisted: number;
  duplicates: number;
  alertsCreated: number;
  notificationsSent: number;
  failedSources: string[];
  durationMs: number;
}

export interface RecallAlertView {
  id: string;
  acknowledgedAt: string | null;
  createdAt: string;
  savedProductId: string | null;
  feedEntry: {
    id: string;
    source: string;
    ean: string | null;
    brand: string | null;
    productName: string | null;
    batchNumber: string | null;
    reason: string;
    recalledAt: string;
  };
}

export interface RecallAlertListResult {
  data: RecallAlertView[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Adapter contract — the recall sweep loops every adapter exposed
 * via this token and aggregates their entries.
 */
export interface IRecallFeedAdapter {
  readonly source: RecallFeedSource;
  fetch(): Promise<FeedEntryDraft[]>;
}

export const RECALL_FEED_ADAPTERS = Symbol('RECALL_FEED_ADAPTERS');
