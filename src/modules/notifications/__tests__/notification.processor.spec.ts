import { NotificationProcessor } from '../processors/notification.processor';

const buildProcessor = (
  dispatch: jest.Mock = jest.fn(async () => ({
    notificationId: 'n1',
    status: 'sent' as const,
    channels: [{ channel: 'in-app', delivered: true }],
  })),
) => {
  const notifications = { dispatchNow: dispatch };
  const appLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const metrics = { counter: jest.fn(), histogram: jest.fn(), gauge: jest.fn() };
  return {
    proc: new NotificationProcessor(notifications as never, appLogger as never, metrics as never),
    notifications,
    metrics,
    appLogger,
  };
};

describe('NotificationProcessor.process', () => {
  it('returns sent + delivered count on success', async () => {
    const { proc, metrics } = buildProcessor();
    const result = await proc.process({
      id: 'j1',
      data: { notificationId: 'n1' },
      attemptsMade: 0,
    });

    expect(result).toEqual({
      notificationId: 'n1',
      status: 'sent',
      deliveredChannels: 1,
    });
    expect(metrics.counter).toHaveBeenCalledWith('notification.dispatch.success', 1);
  });

  it('throws when dispatch returns failed (so BullMQ retries)', async () => {
    const dispatch = jest.fn(async () => ({
      notificationId: 'n1',
      status: 'failed' as const,
      channels: [{ channel: 'in-app', delivered: false, error: 'x' }],
    }));
    const { proc, metrics } = buildProcessor(dispatch);

    await expect(
      proc.process({
        id: 'j2',
        data: { notificationId: 'n1' },
        attemptsMade: 0,
      }),
    ).rejects.toThrow(/failed all channels/);

    expect(metrics.counter).toHaveBeenCalledWith('notification.dispatch.failed', 1);
  });

  it('rethrows underlying errors and emits dispatch.error metric', async () => {
    const dispatch = jest.fn(async () => {
      throw new Error('boom');
    });
    const { proc, metrics } = buildProcessor(dispatch);

    await expect(
      proc.process({
        id: 'j3',
        data: { notificationId: 'n1' },
        attemptsMade: 1,
      }),
    ).rejects.toThrow('boom');

    expect(metrics.counter).toHaveBeenCalledWith('notification.dispatch.error', 1);
  });
});
