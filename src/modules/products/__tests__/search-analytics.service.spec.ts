import { LoggerService } from '@/logging/logger.service';

import { SearchRepository } from '../repositories/search.repository';
import { SearchAnalyticsService } from '../services/search-analytics.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildRepo = (
  overrides: Partial<{
    logSearch: jest.Mock;
  }> = {},
): { repo: SearchRepository } => {
  const repo = {
    logSearch: overrides.logSearch ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as SearchRepository;
  return { repo };
};

describe('SearchAnalyticsService.persist', () => {
  it('forwards the event to the repo with default source=search', async () => {
    const { repo } = buildRepo();
    const svc = new SearchAnalyticsService(repo, buildLogger());
    await svc.persist({
      query: 'chocolate',
      tenantId: 't-1',
      userId: 'u-1',
      resultCount: 12,
      durationMs: 45,
    });
    expect((repo.logSearch as jest.Mock).mock.calls[0][0]).toMatchObject({
      tenantId: 't-1',
      userId: 'u-1',
      queryText: 'chocolate',
      resultCount: 12,
      durationMs: 45,
      source: 'search',
    });
  });

  it('respects the source override (autocomplete)', async () => {
    const { repo } = buildRepo();
    const svc = new SearchAnalyticsService(repo, buildLogger());
    await svc.persist({
      query: 'choc',
      tenantId: 't-1',
      resultCount: 0,
      durationMs: 12,
      source: 'autocomplete',
    });
    expect((repo.logSearch as jest.Mock).mock.calls[0][0].source).toBe('autocomplete');
  });

  it('swallows repo errors and logs them', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('connection refused'));
    const { repo } = buildRepo({ logSearch: failing });
    const logger = buildLogger();
    const svc = new SearchAnalyticsService(repo, logger);
    await expect(
      svc.persist({ query: 'x', tenantId: null, resultCount: 0, durationMs: 1 }),
    ).resolves.toBeUndefined();
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toBe('search.analytics.failed');
  });
});

describe('SearchAnalyticsService.track (fire-and-forget)', () => {
  it('returns synchronously while the persist call runs in the background', () => {
    const { repo } = buildRepo();
    const svc = new SearchAnalyticsService(repo, buildLogger());
    const ret = svc.track({
      query: 'x',
      tenantId: null,
      resultCount: 0,
      durationMs: 1,
    });
    expect(ret).toBeUndefined();
  });

  it('does not throw when the repo throws synchronously', () => {
    const sync = jest.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const { repo } = buildRepo({ logSearch: sync });
    const svc = new SearchAnalyticsService(repo, buildLogger());
    expect(() =>
      svc.track({ query: 'x', tenantId: null, resultCount: 0, durationMs: 1 }),
    ).not.toThrow();
  });
});
