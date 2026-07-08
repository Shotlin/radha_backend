import type { RecallFeedEntryRow } from '@/db/schema/recall';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AuditLogService } from '@/observability/audit-log.service';
import { IErrorTrackingService } from '@/observability/error-tracking.types';

import { RecallAlertsRepository } from '../repositories/recall-alerts.repository';
import { RecallFeedService } from '../services/recall-feed.service';
import { RecallSweepService } from '../services/recall-sweep.service';
import type { FeedEntryDraft, SavedProductMatch } from '../types/recall.types';

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

const buildAuditLog = (): AuditLogService =>
  ({
    logAction: jest.fn().mockResolvedValue(undefined),
    logBatch: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  }) as unknown as AuditLogService;

const draft = (overrides: Partial<FeedEntryDraft> = {}): FeedEntryDraft => ({
  source: 'fssai',
  ean: '8901058000016',
  brand: 'TestBrand',
  productName: 'Cereal',
  batchNumber: 'B-1',
  reason: 'Contamination',
  recalledAt: '2025-01-15',
  raw: { id: 'raw' },
  ...overrides,
});

const feedEntryRow = (overrides: Partial<RecallFeedEntryRow> = {}): RecallFeedEntryRow =>
  ({
    id: 'entry-1',
    source: 'fssai',
    ean: '8901058000016',
    brand: 'TestBrand',
    productName: 'Cereal',
    batchNumber: 'B-1',
    reason: 'Contamination',
    recalledAt: '2025-01-15' as unknown as RecallFeedEntryRow['recalledAt'],
    raw: { id: 'raw' },
    fetchedAt: new Date(),
    ...overrides,
  }) as RecallFeedEntryRow;

const buildSvc = (opts: {
  drafts?: FeedEntryDraft[];
  failedSources?: string[];
  matches?: Record<string, SavedProductMatch[]>;
  alertCreatedFor?: Set<string>;
  notificationFails?: boolean;
}) => {
  const drafts = opts.drafts ?? [];
  const matches = opts.matches ?? {};
  const alertCreatedFor = opts.alertCreatedFor ?? new Set(drafts.map((d) => d.ean ?? ''));

  const feed = {
    fetchAll: jest.fn().mockResolvedValue({
      entries: drafts,
      failedSources: opts.failedSources ?? [],
    }),
    persistFeedEntry: jest.fn(async (d: FeedEntryDraft) => ({
      row: feedEntryRow({
        id: `entry-${d.ean ?? 'no-ean'}`,
        source: d.source,
        ean: d.ean,
        productName: d.productName,
        reason: d.reason,
      }),
      created: true,
    })),
  } as unknown as RecallFeedService;

  const alerts = {
    findMatchesByEan: jest.fn(async (ean: string) => matches[ean] ?? []),
    createIfMissing: jest.fn(
      async (data: {
        tenantId: string;
        userId: string;
        savedProductId: string | null;
        recallFeedEntryId: string;
      }) => {
        const key = `${data.userId}:${data.savedProductId}:${data.recallFeedEntryId}`;
        if (alertCreatedFor.has(key) || alertCreatedFor.size === 0) {
          return {
            id: `alert-${key}`,
            tenantId: data.tenantId,
            userId: data.userId,
            savedProductId: data.savedProductId,
            recallFeedEntryId: data.recallFeedEntryId,
            acknowledgedAt: null,
            createdAt: new Date(),
          };
        }
        return null;
      },
    ),
  } as unknown as RecallAlertsRepository;

  const notifications = {
    send: jest.fn(async () => {
      if (opts.notificationFails) {
        throw new Error('FCM down');
      }
      return { notificationId: 'n1', status: 'sent', channels: [] };
    }),
  } as unknown as NotificationsService;

  const svc = new RecallSweepService(
    feed,
    alerts,
    notifications,
    buildLogger(),
    buildAuditLog(),
    buildErrorTracking(),
  );

  return { svc, feed, alerts, notifications };
};

describe('RecallSweepService', () => {
  it('fetches, persists, matches and notifies — happy path', async () => {
    const match: SavedProductMatch = {
      userId: 'u1',
      tenantId: 't1',
      savedProductId: 'sp1',
    };
    const { svc, alerts, notifications } = buildSvc({
      drafts: [draft({ ean: '111' })],
      matches: { '111': [match] },
      alertCreatedFor: new Set([`u1:sp1:entry-111`]),
    });

    const report = await svc.runSweep();

    expect(report.fetched).toBe(1);
    expect(report.persisted).toBe(1);
    expect(report.alertsCreated).toBe(1);
    expect(report.notificationsSent).toBe(1);
    expect(alerts.createIfMissing).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        tenantId: 't1',
        category: 'recall-alert',
        channels: expect.arrayContaining(['push']),
      }),
    );
  });

  it('skips notification when alert already existed (UNIQUE conflict)', async () => {
    const match: SavedProductMatch = {
      userId: 'u1',
      tenantId: 't1',
      savedProductId: 'sp1',
    };
    const { svc, alerts, notifications } = buildSvc({
      drafts: [draft({ ean: '111' })],
      matches: { '111': [match] },
      alertCreatedFor: new Set(['__never__']),
    });

    // Force conflict by overriding createIfMissing to return null.
    (alerts.createIfMissing as jest.Mock).mockResolvedValue(null);

    const report = await svc.runSweep();

    expect(report.alertsCreated).toBe(0);
    expect(report.notificationsSent).toBe(0);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('does not throw when notifications.send fails — alert row is the source of truth', async () => {
    const match: SavedProductMatch = {
      userId: 'u1',
      tenantId: 't1',
      savedProductId: 'sp1',
    };
    const { svc } = buildSvc({
      drafts: [draft({ ean: '111' })],
      matches: { '111': [match] },
      alertCreatedFor: new Set([`u1:sp1:entry-111`]),
      notificationFails: true,
    });

    const report = await svc.runSweep();
    expect(report.alertsCreated).toBe(1);
    expect(report.notificationsSent).toBe(0);
  });

  it('records failed sources in the report without throwing', async () => {
    const { svc } = buildSvc({
      drafts: [],
      failedSources: ['fssai'],
    });
    const report = await svc.runSweep();
    expect(report.failedSources).toEqual(['fssai']);
    expect(report.fetched).toBe(0);
  });

  it('skips matching when feed entry has no EAN', async () => {
    const { svc, alerts } = buildSvc({
      drafts: [draft({ ean: null })],
    });

    await svc.runSweep();
    expect(alerts.findMatchesByEan).not.toHaveBeenCalled();
  });

  it('creates one alert per match across multiple users', async () => {
    const matches: SavedProductMatch[] = [
      { userId: 'u1', tenantId: 't1', savedProductId: 'sp1' },
      { userId: 'u2', tenantId: 't2', savedProductId: 'sp2' },
    ];
    const { svc, alerts, notifications } = buildSvc({
      drafts: [draft({ ean: '111' })],
      matches: { '111': matches },
      alertCreatedFor: new Set(['u1:sp1:entry-111', 'u2:sp2:entry-111']),
    });

    const report = await svc.runSweep();
    expect(alerts.createIfMissing).toHaveBeenCalledTimes(2);
    expect(notifications.send).toHaveBeenCalledTimes(2);
    expect(report.alertsCreated).toBe(2);
    expect(report.notificationsSent).toBe(2);
  });
});
