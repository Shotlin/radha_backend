import { LoggerService } from '@/logging/logger.service';
import { IErrorTrackingService } from '@/observability/error-tracking.types';

import { RecallFeedEntriesRepository } from '../repositories/recall-feed-entries.repository';
import { RecallFeedService } from '../services/recall-feed.service';
import type { FeedEntryDraft, IRecallFeedAdapter } from '../types/recall.types';

class TestRecallFeedService extends RecallFeedService {
  protected sleep(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  }) as unknown as LoggerService;

const buildErrorTracking = (): IErrorTrackingService =>
  ({
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    setUser: jest.fn(),
    clearUser: jest.fn(),
    addBreadcrumb: jest.fn(),
    setTag: jest.fn(),
    setContext: jest.fn(),
  }) as unknown as IErrorTrackingService;

const buildAdapter = (
  source: string,
  fetchImpl: () => Promise<FeedEntryDraft[]>,
): IRecallFeedAdapter => ({
  source,
  fetch: jest.fn(fetchImpl),
});

const draft = (overrides: Partial<FeedEntryDraft> = {}): FeedEntryDraft => ({
  source: 'fssai',
  ean: '8901058000016',
  brand: 'B',
  productName: 'P',
  batchNumber: 'B-1',
  reason: 'R',
  recalledAt: '2025-01-15',
  raw: { id: 'raw-1' },
  ...overrides,
});

describe('RecallFeedService', () => {
  describe('fetchAll — retry behaviour', () => {
    it('returns entries from the first successful attempt without retry', async () => {
      const adapter = buildAdapter('fssai', async () => [draft()]);
      const repo = {} as RecallFeedEntriesRepository;
      const svc = new TestRecallFeedService(repo, buildLogger(), buildErrorTracking(), [adapter]);

      const result = await svc.fetchAll();
      expect(result.entries).toHaveLength(1);
      expect(result.failedSources).toHaveLength(0);
      expect(adapter.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries up to 3 times before giving up on a single source', async () => {
      let calls = 0;
      const adapter = buildAdapter('fssai', async () => {
        calls += 1;
        throw new Error('boom');
      });
      const repo = {} as RecallFeedEntriesRepository;
      const errorTracking = buildErrorTracking();
      const svc = new TestRecallFeedService(repo, buildLogger(), errorTracking, [adapter]);

      const result = await svc.fetchAll();
      expect(calls).toBe(3);
      expect(result.entries).toHaveLength(0);
      expect(result.failedSources).toEqual(['fssai']);
      expect(errorTracking.captureException).toHaveBeenCalledTimes(1);
    });

    it('returns success on the third attempt after two failures', async () => {
      let calls = 0;
      const adapter = buildAdapter('fssai', async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return [draft()];
      });
      const repo = {} as RecallFeedEntriesRepository;
      const svc = new TestRecallFeedService(repo, buildLogger(), buildErrorTracking(), [adapter]);

      const result = await svc.fetchAll();
      expect(calls).toBe(3);
      expect(result.entries).toHaveLength(1);
      expect(result.failedSources).toHaveLength(0);
    });

    it('isolates per-source failures across multiple adapters', async () => {
      const a = buildAdapter('fssai', async () => [draft({ source: 'fssai' })]);
      const b = buildAdapter('mofpi', async () => {
        throw new Error('down');
      });
      const repo = {} as RecallFeedEntriesRepository;
      const svc = new TestRecallFeedService(repo, buildLogger(), buildErrorTracking(), [a, b]);

      const result = await svc.fetchAll();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].source).toBe('fssai');
      expect(result.failedSources).toEqual(['mofpi']);
    });
  });

  describe('persistFeedEntry — dedupe', () => {
    it('inserts a new row when no existing entry matches', async () => {
      const repo = {
        findExisting: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-row', source: 'fssai' }),
      } as unknown as RecallFeedEntriesRepository;
      const svc = new TestRecallFeedService(repo, buildLogger(), buildErrorTracking(), []);

      const result = await svc.persistFeedEntry(draft());
      expect(result.created).toBe(true);
      expect(result.row.id).toBe('new-row');
      expect(repo.create).toHaveBeenCalled();
    });

    it('returns the existing row on natural-key match without re-inserting', async () => {
      const existing = { id: 'existing-row', source: 'fssai' };
      const repo = {
        findExisting: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
      } as unknown as RecallFeedEntriesRepository;
      const svc = new TestRecallFeedService(repo, buildLogger(), buildErrorTracking(), []);

      const result = await svc.persistFeedEntry(draft());
      expect(result.created).toBe(false);
      expect(result.row).toBe(existing);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });
});
