import type { NotificationRow } from '@/db/schema/notifications';

import { NotificationRouterService } from '../services/notification-router.service';

const baseRow = (): NotificationRow =>
  ({
    id: 'n1',
    tenantId: 't1',
    userId: 'u1',
    category: 'task',
    template: null,
    subject: 'Hello',
    body: 'World',
    bodyHtml: '<p>World</p>',
    priority: 'normal',
    channels: [],
    emailStatus: null,
    smsStatus: null,
    pushStatus: null,
    inAppStatus: null,
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
  }) as unknown as NotificationRow;

const buildSvc = (
  overrides: {
    email?: { delivered: boolean; error?: string };
    sms?: { delivered: boolean; error?: string };
    push?: { delivered: boolean; error?: string };
    contact?: { email?: string; mobile?: string };
  } = {},
) => {
  const emailChannel = {
    deliver: jest.fn(async () => ({
      channel: 'email' as const,
      delivered: overrides.email?.delivered ?? true,
      ...(overrides.email?.error ? { error: overrides.email.error } : {}),
    })),
  };
  const smsChannel = {
    deliver: jest.fn(async () => ({
      channel: 'sms' as const,
      delivered: overrides.sms?.delivered ?? true,
      ...(overrides.sms?.error ? { error: overrides.sms.error } : {}),
    })),
  };
  const pushChannel = {
    deliver: jest.fn(async () => ({
      channel: 'push' as const,
      delivered: overrides.push?.delivered ?? true,
      ...(overrides.push?.error ? { error: overrides.push.error } : {}),
    })),
  };
  const users = {
    findById: jest.fn(async () => ({
      id: 'u1',
      email: overrides.contact?.email ?? 'a@b.com',
      mobile: overrides.contact?.mobile ?? '+911234567890',
    })),
  };
  const appLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    svc: new NotificationRouterService(
      emailChannel as never,
      smsChannel as never,
      pushChannel as never,
      users as never,
      appLogger as never,
    ),
    emailChannel,
    smsChannel,
    pushChannel,
    users,
  };
};

describe('NotificationRouterService.sendToChannels', () => {
  it('returns empty when no channels requested', async () => {
    const { svc } = buildSvc();
    const out = await svc.sendToChannels(baseRow(), []);
    expect(out).toEqual([]);
  });

  it('dispatches email + push + in-app concurrently and returns per-channel result', async () => {
    const { svc, emailChannel, pushChannel } = buildSvc();
    const out = await svc.sendToChannels(baseRow(), ['email', 'push', 'in-app']);

    expect(out).toHaveLength(3);
    expect(out.find((r) => r.channel === 'email')?.delivered).toBe(true);
    expect(out.find((r) => r.channel === 'push')?.delivered).toBe(true);
    expect(out.find((r) => r.channel === 'in-app')?.delivered).toBe(true);
    expect(emailChannel.deliver).toHaveBeenCalledTimes(1);
    expect(pushChannel.deliver).toHaveBeenCalledTimes(1);
  });

  it('captures channel-level rejections without throwing', async () => {
    const { svc, emailChannel } = buildSvc();
    (emailChannel.deliver as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    const out = await svc.sendToChannels(baseRow(), ['email', 'in-app']);

    const email = out.find((r) => r.channel === 'email');
    expect(email?.delivered).toBe(false);
    expect(email?.error).toBe('boom');
    const inApp = out.find((r) => r.channel === 'in-app');
    expect(inApp?.delivered).toBe(true);
  });

  it('returns partial failure when only some channels deliver', async () => {
    const { svc } = buildSvc({
      email: { delivered: false, error: 'no email' },
      push: { delivered: true },
    });
    const out = await svc.sendToChannels(baseRow(), ['email', 'push']);
    const failed = out.find((r) => !r.delivered);
    expect(failed?.error).toBe('no email');
  });

  it('uses an empty contact when user lookup fails (channels still called)', async () => {
    const { svc, users, emailChannel } = buildSvc();
    (users.findById as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await svc.sendToChannels(baseRow(), ['email']);
    expect(emailChannel.deliver).toHaveBeenCalledTimes(1);
    const mockFn = emailChannel.deliver as unknown as jest.Mock;
    const call = mockFn.mock.calls[0];
    expect(call).toBeDefined();
    const arg = call?.[1];
    expect(arg).toEqual({});
  });
});
