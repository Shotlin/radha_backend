import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import type { FeedEntryDraft, IRecallFeedAdapter } from '../types/recall.types';

/**
 * BE-39 — FSSAI public recall feed adapter.
 *
 * v1 ships a stub HTTP adapter that returns a small mock payload so
 * the sweep job has something to chew on in dev and tests. The
 * production wiring will:
 *
 *   1. read `FSSAI_RECALL_FEED_URL` from config,
 *   2. fetch with a 10s timeout + RADHA user-agent,
 *   3. parse the JSON / RSS payload (publisher hasn't picked yet),
 *   4. coerce each row into `FeedEntryDraft`.
 *
 * Keeping the contract narrow (`fetch(): Promise<FeedEntryDraft[]>`)
 * means the sweep service doesn't care which publisher this is —
 * adding MoFPI/CDSCO is "another adapter, register it in
 * `RECALL_FEED_ADAPTERS`".
 */
@Injectable()
export class FssaiFeedAdapter implements IRecallFeedAdapter {
  readonly source = 'fssai';

  /**
   * Override target. Tests stub this to inject canned responses.
   * Production override slot for the real `fetch()` call.
   */
  protected fetchUrl: string | null = null;

  constructor(private readonly logger: LoggerService) {}

  async fetch(): Promise<FeedEntryDraft[]> {
    if (this.fetchUrl) {
      return this.fetchHttp(this.fetchUrl);
    }
    this.logger.debug('recall.fssai.using-mock');
    return this.mockFeed();
  }

  /**
   * Real-network code path. Wired up only when `FSSAI_RECALL_FEED_URL`
   * is configured — kept here as a clear seam so the production
   * deploy doesn't accidentally serve the mock data.
   *
   * Tests override `request()` rather than `fetchUrl` to avoid live
   * HTTP.
   */
  protected async fetchHttp(url: string): Promise<FeedEntryDraft[]> {
    const res = await this.request(url);
    if (!res.ok) {
      throw new Error(`FSSAI feed returned ${res.status}`);
    }
    const body = (await res.json()) as { entries?: unknown[] };
    if (!Array.isArray(body.entries)) {
      throw new Error('FSSAI feed missing "entries" array');
    }
    return body.entries
      .map((row) => this.normalise(row))
      .filter((row): row is FeedEntryDraft => row !== null);
  }

  /** Test seam — overridden to avoid live HTTP. */
  protected async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'RADHA-Backend/1.0 (+https://radha.app)',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private normalise(row: unknown): FeedEntryDraft | null {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    const reason = typeof r.reason === 'string' ? r.reason : null;
    const recalledAt = typeof r.recalled_at === 'string' ? r.recalled_at : null;
    if (!reason || !recalledAt) return null;
    return {
      source: this.source,
      ean: typeof r.ean === 'string' ? r.ean : null,
      brand: typeof r.brand === 'string' ? r.brand : null,
      productName: typeof r.product_name === 'string' ? r.product_name : null,
      batchNumber: typeof r.batch_number === 'string' ? r.batch_number : null,
      reason,
      recalledAt,
      raw: r,
    };
  }

  private mockFeed(): FeedEntryDraft[] {
    return [
      {
        source: this.source,
        ean: '8901058000016',
        brand: 'Mock Brand',
        productName: 'Mock Cereal 500g',
        batchNumber: 'B-2025-001',
        reason: 'Possible metal contamination',
        recalledAt: new Date().toISOString().slice(0, 10),
        raw: {
          source: 'fssai-mock',
          ean: '8901058000016',
          brand: 'Mock Brand',
          product_name: 'Mock Cereal 500g',
          batch_number: 'B-2025-001',
          reason: 'Possible metal contamination',
          recalled_at: new Date().toISOString().slice(0, 10),
        },
      },
    ];
  }
}
