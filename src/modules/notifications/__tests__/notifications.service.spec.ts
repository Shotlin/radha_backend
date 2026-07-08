import { NotificationsService } from '../notifications.service';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationPreferences,
  SendNotificationDto,
} from '../types/notification.types';

const baseRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: overrides.id ?? 'n1',
  tenantId: 't1',
  userId: 'u1',
  category: 'task' as NotificationCategory,
  template: null,
  subject: 'Hello',
  body: 'World',
  bodyHtml: '<p>World</p>',
  priority: 'normal',
  channels: ['in-app', 'email'],
  emailStatus: 'queued',
  smsStatus: null,
  pushStatus: null,
  inAppStatus: 'queued',
  isRead: false,
  readAt: null,
  sentAt: null,
  scheduledFor: null,
  failedAt: null,
  attemptCount: 0,
  relatedResourceType: null,
  relatedResourceId: null,
  data: null,
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const buildPrefs = (overrides: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  userId: 'u1',
  channels: { email: true, sms: true, push: true, inApp: true },
  categories: {
    auth: true,
    'expiry-alert': true,
    task: true,
    report: true,
    system: true,
    marketing: false,
    'recall-alert': true,
    'daily-insights': true,
    'business-activation': true,
  },
  digestFrequency: 'realtime',
  ...overrides,
});

const buildSvc = (
  opts: {
    prefs?: NotificationPreferences;
    isQuietHours?: boolean;
    queue?: { add: jest.Mock };
    routerResults?: Array<{
      channel: NotificationChannel;
      delivered: boolean;
      error?: string;
    }>;
  } = {},
) => {
  const stored: Record<string, Record<string, unknown>> = {};
  let counter = 0;

  const repo = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      counter += 1;
      const id = `n${counter}`;
      const row = { ...baseRow({ id, ...data }) };
      stored[id] = row;
      return row;
    }),
    findById: jest.fn(async (id: string) => stored[id] ?? null),
    update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
      stored[id] = { ...(stored[id] ?? baseRow({ id })), ...patch };
      return stored[id];
    }),
    incrementAttempts: jest.fn(async () => undefined),
    listForUser: jest.fn(async () => []),
    markRead: jest.fn(async () => true),
    markAllRead: jest.fn(async () => 0),
    findDueScheduled: jest.fn(async () => []),
    deleteOlderThan: jest.fn(async () => 0),
    findExpiredOlderThan: jest.fn(async () => []),
    getUnreadCount: jest.fn(async () => 0),
    countSentInWindow: jest.fn(async () => 0),
  } as unknown as ConstructorParameters<typeof NotificationsService>[0];

  const preferences = {
    getPreferences: jest.fn(async () => opts.prefs ?? buildPrefs()),
    filterChannels: jest.fn(
      (
        prefs: NotificationPreferences,
        requested: NotificationChannel[],
        category: NotificationCategory,
      ) => {
        if (!prefs.categories[category]) return [];
        return requested.filter((c) => {
          if (c === 'sms' && category !== 'auth') return false;
          const map: Record<NotificationChannel, boolean> = {
            email: prefs.channels.email,
            sms: prefs.channels.sms,
            push: prefs.channels.push,
            'in-app': prefs.channels.inApp,
          };
          return map[c];
        });
      },
    ),
    isQuietHours: jest.fn(() => opts.isQuietHours ?? false),
    nextActiveTime: jest.fn(() => new Date(Date.now() + 60 * 60 * 1000)),
    updatePreferences: jest.fn(async () => opts.prefs ?? buildPrefs()),
  } as unknown as ConstructorParameters<typeof NotificationsService>[1];

  const router = {
    sendToChannels: jest.fn(
      async (_row: unknown, channels: NotificationChannel[]) =>
        opts.routerResults ?? channels.map((c) => ({ channel: c, delivered: true })),
    ),
  } as unknown as ConstructorParameters<typeof NotificationsService>[2];

  const templates = {
    render: jest.fn(async () => ({
      subject: 'Sub',
      body: 'Body',
      html: '<p>Body</p>',
    })),
    defaultChannelsFor: jest.fn(() => ['in-app']),
    defaultCategoryFor: jest.fn(() => 'system'),
  } as unknown as ConstructorParameters<typeof NotificationsService>[3];

  const deviceTokens = {
    upsertByToken: jest.fn(async () => ({ id: 'd1' })),
    deactivateByUserAndToken: jest.fn(async () => undefined),
  } as unknown as ConstructorParameters<typeof NotificationsService>[4];

  const appLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as ConstructorParameters<typeof NotificationsService>[5];

  const auditLog = {
    logAction: jest.fn(async () => undefined),
  } as unknown as ConstructorParameters<typeof NotificationsService>[6];

  const svc = new NotificationsService(
    repo,
    preferences,
    router,
    templates,
    deviceTokens,
    appLogger,
    auditLog,
    opts.queue as never,
  );

  return {
    svc,
    repo,
    preferences,
    router,
    templates,
    deviceTokens,
    auditLog,
    stored,
  };
};

const baseDto: SendNotificationDto = {
  tenantId: 't1',
  userId: 'u1',
  channels: ['in-app', 'email'],
  category: 'task',
  subject: 'Hello',
  body: 'World',
  forceSync: true, // default to sync for testability
};

describe('NotificationsService.send', () => {
  it('persists row, dispatches synchronously, marks per-channel statuses', async () => {
    const { svc, repo, router } = buildSvc();
    const result = await svc.send(baseDto);

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(router.sendToChannels).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('sent');
    expect(result.channels.every((c) => c.delivered)).toBe(true);

    const updateCalls = (repo.update as jest.Mock).mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][1];
    expect(finalUpdate.emailStatus).toBe('sent');
    expect(finalUpdate.inAppStatus).toBe('delivered');
    expect(finalUpdate.sentAt).toBeInstanceOf(Date);
  });

  it('blocks all channels when category is opted out and emits a "skipped" row', async () => {
    const prefs = buildPrefs();
    prefs.categories.marketing = false;
    const { svc, repo, router } = buildSvc({ prefs });

    const result = await svc.send({
      ...baseDto,
      category: 'marketing',
      channels: ['email'],
    });

    expect(result.status).toBe('skipped');
    expect(router.sendToChannels).not.toHaveBeenCalled();
    const created = (repo.create as jest.Mock).mock.calls[0][0];
    expect(created.emailStatus).toBe('skipped');
  });

  it('reschedules non-urgent sends during quiet hours', async () => {
    const prefs = buildPrefs({
      quietHours: {
        enabled: true,
        start: '00:00',
        end: '23:59',
        timezone: 'UTC',
      },
    });
    const queue = { add: jest.fn(async () => ({ id: 'j1' })) as jest.Mock };
    const { svc, router } = buildSvc({ prefs, isQuietHours: true, queue });

    const result = await svc.send({ ...baseDto, forceSync: false });

    expect(result.status).toBe('queued');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(router.sendToChannels).not.toHaveBeenCalled();
    const call = queue.add.mock.calls[0];
    expect(call).toBeDefined();
    const opts = call?.[2];
    expect(opts).toBeDefined();
    expect(opts).toMatchObject({ delay: expect.any(Number) });
  });

  it('drops SMS for non-auth categories', async () => {
    const { svc, repo } = buildSvc();
    const result = await svc.send({
      ...baseDto,
      channels: ['sms', 'in-app'],
    });

    const created = (repo.create as jest.Mock).mock.calls[0][0];
    expect(created.channels).toEqual(['in-app']);
    expect(result.status).toBe('sent');
  });

  it('marks failed when every channel fails', async () => {
    const { svc, repo } = buildSvc({
      routerResults: [
        { channel: 'email', delivered: false, error: 'boom' },
        { channel: 'in-app', delivered: false, error: 'boom' },
      ],
    });

    const result = await svc.send(baseDto);
    expect(result.status).toBe('failed');
    const updateCalls = (repo.update as jest.Mock).mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][1];
    expect(finalUpdate.emailStatus).toBe('failed');
    expect(finalUpdate.failedAt).toBeInstanceOf(Date);
    expect(finalUpdate.error).toBe('boom');
  });

  it('enqueues when a queue is wired and forceSync is false', async () => {
    const queue = { add: jest.fn(async () => ({ id: 'j1' })) };
    const { svc } = buildSvc({ queue });

    const result = await svc.send({ ...baseDto, forceSync: false });
    expect(result.status).toBe('queued');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationsService.markAsRead + markAllAsRead', () => {
  it('delegates mark-as-read', async () => {
    const { svc, repo } = buildSvc();
    await svc.markAsRead('n1', 'u1');
    expect(repo.markRead).toHaveBeenCalledWith('n1', 'u1', expect.any(Date));
  });

  it('returns updated count for mark-all', async () => {
    const { svc, repo } = buildSvc();
    (repo.markAllRead as jest.Mock).mockResolvedValueOnce(5);
    const out = await svc.markAllAsRead('u1');
    expect(out).toEqual({ updated: 5 });
  });
});

describe('NotificationsService.dispatchDue', () => {
  it('returns zero when no rows due', async () => {
    const { svc } = buildSvc();
    const out = await svc.dispatchDue();
    expect(out).toEqual({ scanned: 0, queued: 0, dispatchedSync: 0 });
  });

  it('queues each row when a queue is wired', async () => {
    const queue = { add: jest.fn(async () => ({ id: 'j1' })) };
    const { svc, repo } = buildSvc({ queue });
    (repo.findDueScheduled as jest.Mock).mockResolvedValueOnce([
      baseRow({ id: 'a' }),
      baseRow({ id: 'b' }),
    ]);
    const out = await svc.dispatchDue();
    expect(out).toEqual({ scanned: 2, queued: 2, dispatchedSync: 0 });
  });

  it('dispatches sync when queue is absent', async () => {
    const { svc, repo, router } = buildSvc();
    const row = baseRow({ id: 'a' });
    (repo.findDueScheduled as jest.Mock).mockResolvedValueOnce([row]);
    (repo.findById as jest.Mock).mockResolvedValueOnce(row);
    const out = await svc.dispatchDue();
    expect(out.scanned).toBe(1);
    expect(out.dispatchedSync).toBe(1);
    expect(router.sendToChannels).toHaveBeenCalled();
  });
});

describe('NotificationsService.sendBulk', () => {
  it('counts successes and partial failures', async () => {
    const { svc, router } = buildSvc();
    (router.sendToChannels as jest.Mock).mockImplementation(
      async (row: { userId: string }, channels: NotificationChannel[]) => {
        if (row.userId === 'fail') {
          return channels.map((c) => ({
            channel: c,
            delivered: false,
            error: 'x',
          }));
        }
        return channels.map((c) => ({ channel: c, delivered: true }));
      },
    );

    const result = await svc.sendBulk({
      tenantId: 't1',
      userIds: ['ok', 'fail', 'ok2'],
      channels: ['in-app'],
      category: 'task',
      subject: 'S',
      body: 'B',
    });

    expect(result.totalRecipients).toBe(3);
    expect(result.successful).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0].userId).toBe('fail');
  });
});
