import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { PreferenceManagerService } from '@/modules/notifications/services/preference-manager.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { ConsumerWeeklyDigestRow } from '@/db/schema/consumer-weekly-digests';

import type { WeeklyDigestPayload } from '../dto/weekly-digest.dto';
import { WeeklyDigestRepository } from '../repositories/weekly-digest.repository';
import { DigestPayloadBuilderService } from '../services/digest-payload-builder.service';
import { WeeklyDigestService } from '../services/weekly-digest.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  }) as unknown as LoggerService;

const buildAuditLog = (): AuditLogService =>
  ({
    logAction: jest.fn().mockResolvedValue(undefined),
    logBatch: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  }) as unknown as AuditLogService;

const samplePayload = (overrides: Partial<WeeklyDigestPayload> = {}): WeeklyDigestPayload => ({
  scansCount: 5,
  highSugarCount: 1,
  recallCount: 0,
  alternativesRecommended: 2,
  topProducts: [],
  savings: 0,
  ...overrides,
});

const sampleRow = (overrides: Partial<ConsumerWeeklyDigestRow> = {}): ConsumerWeeklyDigestRow =>
  ({
    id: 'digest-1',
    userId: 'u-1',
    weekStarting: '2025-03-10',
    scansCount: 5,
    highSugarCount: 1,
    recallCount: 0,
    alternativesRecommended: 2,
    payload: {} as Record<string, unknown>,
    createdAt: new Date('2025-03-16T02:30:00Z'),
    deliveredAt: null,
    ...overrides,
  }) as ConsumerWeeklyDigestRow;

const buildDeps = (opts: {
  optedOut?: boolean;
  alreadyExists?: boolean;
  insertReturnsNull?: boolean;
  notificationFails?: boolean;
} = {}) => {
  const repo = {
    listActiveConsumers: jest.fn().mockResolvedValue([]),
    existsForWeek: jest.fn().mockResolvedValue(opts.alreadyExists ?? false),
    findByUserAndWeek: jest.fn(),
    insertIfMissing: jest
      .fn()
      .mockResolvedValue(opts.insertReturnsNull ? null : sampleRow()),
    markDelivered: jest.fn().mockResolvedValue(undefined),
    listUndelivered: jest.fn().mockResolvedValue([]),
  } as unknown as WeeklyDigestRepository;

  const payloadBuilder = {
    build: jest.fn().mockResolvedValue(samplePayload()),
  } as unknown as DigestPayloadBuilderService;

  const notifications = {
    send: jest.fn(async () => {
      if (opts.notificationFails) throw new Error('FCM down');
      return { notificationId: 'n-1', status: 'sent', channels: [] };
    }),
  } as unknown as NotificationsService;

  const preferences = {
    getPreferences: jest.fn().mockResolvedValue({
      userId: 'u-1',
      channels: { email: true, sms: false, push: true, inApp: true },
      categories: { 'daily-insights': !opts.optedOut },
      digestFrequency: 'realtime',
    }),
    filterChannels: jest.fn((_prefs, requested: string[], _category) =>
      opts.optedOut ? [] : requested,
    ),
  } as unknown as PreferenceManagerService;

  const service = new WeeklyDigestService(
    repo,
    payloadBuilder,
    notifications,
    preferences,
    buildLogger(),
    buildAuditLog(),
  );

  return { service, repo, payloadBuilder, notifications, preferences };
};

describe('WeeklyDigestService.computePreviousMondayUtc', () => {
  // Build a service shell with minimal deps — the date math doesn't
  // touch any of them.
  const { service } = buildDeps();

  it('returns the same Monday when invoked any time on Sunday IST', () => {
    // Sunday 2025-03-16 noon IST → previous Monday is 2025-03-10 IST.
    const sundayIstNoon = new Date('2025-03-16T06:30:00Z'); // 12:00 IST
    const mon = service.computePreviousMondayUtc(sundayIstNoon);
    expect(service.toDateString(mon)).toBe('2025-03-10');
  });

  it('also returns 2025-03-10 when invoked Sunday at 08:00 IST (cron time)', () => {
    // 08:00 IST = 02:30 UTC.
    const sundayCron = new Date('2025-03-16T02:30:00Z');
    const mon = service.computePreviousMondayUtc(sundayCron);
    expect(service.toDateString(mon)).toBe('2025-03-10');
  });

  it('returns the Monday at-or-before today for any IST weekday', () => {
    // Wed 2025-03-19 10:00 IST → most recent Monday is 2025-03-17.
    const wednesday = new Date('2025-03-19T04:30:00Z');
    expect(service.toDateString(service.computePreviousMondayUtc(wednesday))).toBe(
      '2025-03-17',
    );
    // Mon 2025-03-17 09:00 IST → 2025-03-17 itself.
    const monday = new Date('2025-03-17T03:30:00Z');
    expect(service.toDateString(service.computePreviousMondayUtc(monday))).toBe(
      '2025-03-17',
    );
  });

  it('handles late-Sunday near midnight IST without rolling back', () => {
    // 23:30 IST Sunday 2025-03-16 = 18:00 UTC same day.
    const lateSunday = new Date('2025-03-16T18:00:00Z');
    expect(service.toDateString(service.computePreviousMondayUtc(lateSunday))).toBe(
      '2025-03-10',
    );
  });
});

describe('WeeklyDigestService.processConsumer', () => {
  const consumer = { userId: 'u-1', tenantId: 't-1', preferredLanguage: 'en' };
  const weekStarting = '2025-03-10';
  const weekStartingUtc = new Date(Date.UTC(2025, 2, 10));

  it('skips when the user opted out of daily-insights', async () => {
    const { service, repo, notifications } = buildDeps({ optedOut: true });

    const outcome = await service.processConsumer(consumer, weekStarting, weekStartingUtc);

    expect(outcome).toBe('opted-out');
    expect(repo.existsForWeek).not.toHaveBeenCalled();
    expect(repo.insertIfMissing).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('is idempotent when a digest already exists for this user+week', async () => {
    const { service, repo, notifications } = buildDeps({ alreadyExists: true });

    const outcome = await service.processConsumer(consumer, weekStarting, weekStartingUtc);

    expect(outcome).toBe('idempotent-skip');
    expect(repo.existsForWeek).toHaveBeenCalledWith('u-1', '2025-03-10');
    expect(repo.insertIfMissing).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('treats an ON CONFLICT race as an idempotent skip', async () => {
    const { service, notifications } = buildDeps({ insertReturnsNull: true });

    const outcome = await service.processConsumer(consumer, weekStarting, weekStartingUtc);

    expect(outcome).toBe('idempotent-skip');
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('marks delivered_at on a successful FCM send', async () => {
    const { service, repo, notifications } = buildDeps();

    const outcome = await service.processConsumer(consumer, weekStarting, weekStartingUtc);

    expect(outcome).toBe('created-and-delivered');
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        tenantId: 't-1',
        category: 'daily-insights',
        subject: 'Your Weekly Health Summary',
        channels: expect.arrayContaining(['push']),
      }),
    );
    expect(repo.markDelivered).toHaveBeenCalledTimes(1);
    const args = (repo.markDelivered as jest.Mock).mock.calls[0];
    expect(args[0]).toBe('digest-1');
    expect(args[1]).toBeInstanceOf(Date);
  });

  it('leaves delivered_at null when the FCM send throws', async () => {
    const { service, repo } = buildDeps({ notificationFails: true });

    const outcome = await service.processConsumer(consumer, weekStarting, weekStartingUtc);

    expect(outcome).toBe('created-not-delivered');
    expect(repo.markDelivered).not.toHaveBeenCalled();
  });

  it('falls back to a "system" tenant when consumer has no tenantId', async () => {
    const { service, notifications } = buildDeps();
    await service.processConsumer(
      { userId: 'u-2', tenantId: null },
      weekStarting,
      weekStartingUtc,
    );
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'system' }),
    );
  });
});

describe('WeeklyDigestService.runForWeek', () => {
  it('aggregates per-consumer outcomes into a report', async () => {
    const { service, repo, payloadBuilder, notifications } = buildDeps();

    // Pretend we have one consumer; second call returns empty to
    // terminate the page loop.
    (repo.listActiveConsumers as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'u-1',
          tenantId: 't-1',
          preferredLanguage: 'en',
          createdAt: new Date('2025-01-01T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const now = new Date('2025-03-16T02:30:00Z');
    const report = await service.runForWeek(now);

    expect(report.consumersScanned).toBe(1);
    expect(report.digestsCreated).toBe(1);
    expect(report.notificationsDelivered).toBe(1);
    expect(report.optedOutSkips).toBe(0);
    expect(report.idempotentSkips).toBe(0);
    expect(payloadBuilder.build).toHaveBeenCalledWith(
      'u-1',
      expect.any(Date),
    );
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('counts opted-out users separately', async () => {
    const { service, repo } = buildDeps({ optedOut: true });
    (repo.listActiveConsumers as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'u-1',
          tenantId: 't-1',
          preferredLanguage: 'en',
          createdAt: new Date('2025-01-01T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const report = await service.runForWeek(new Date('2025-03-16T02:30:00Z'));
    expect(report.optedOutSkips).toBe(1);
    expect(report.digestsCreated).toBe(0);
    expect(report.notificationsDelivered).toBe(0);
  });

  it('counts FCM failures as digestsCreated + notificationsFailed', async () => {
    const { service, repo } = buildDeps({ notificationFails: true });
    (repo.listActiveConsumers as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'u-1',
          tenantId: 't-1',
          preferredLanguage: 'en',
          createdAt: new Date('2025-01-01T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const report = await service.runForWeek(new Date('2025-03-16T02:30:00Z'));
    expect(report.digestsCreated).toBe(1);
    expect(report.notificationsFailed).toBe(1);
    expect(report.notificationsDelivered).toBe(0);
  });
});
