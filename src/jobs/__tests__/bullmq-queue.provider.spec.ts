import { EventEmitter } from 'events';

import type { ConfigService } from '@/config/config.service';

/**
 * BE-24 — Smoke tests for `BullMqBootstrapService` resilience.
 *
 * Verifies the two failure modes that previously produced an
 * infinite `bullmq.redis.error` log loop:
 *   1. `bullmq` / `ioredis` not installed → `bullmq.disabled` warn,
 *      `initialise()` returns null.
 *   2. ioredis emits repeated `'error'` events (Redis unreachable)
 *      → only ONE `bullmq.redis.error` warn fires across the
 *      lifetime of the process.
 *
 * NOTE: each case `jest.resetModules()` + dynamically imports the provider so
 * the `bullmq`/`ioredis` mocks take effect. That means the provider resolves a
 * FRESH `@nestjs/common` — so we must re-import `Logger` from that same fresh
 * graph and spy on it there, otherwise the spy sits on a different `Logger`
 * class and never sees the provider's calls.
 */

const mkConfig = (): ConfigService =>
  ({
    redis: {
      host: 'localhost',
      port: 6379,
      db: 0,
      password: undefined,
      keyPrefix: 'radha:',
      tls: false,
    },
  }) as unknown as ConfigService;

describe('BullMqBootstrapService', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('returns null and logs bullmq.disabled when bullmq/ioredis are unavailable', async () => {
    // A module that fails to load → the provider's `import().catch(() => null)`
    // yields `null`, taking the "disabled" path. (A factory returning `null`
    // would still resolve to a truthy namespace, so it must reject.)
    jest.doMock('bullmq', () => {
      throw new Error('bullmq not installed');
    });
    jest.doMock('ioredis', () => {
      throw new Error('ioredis not installed');
    });

    const { Logger } = await import('@nestjs/common');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const { BullMqBootstrapService } = await import('../bullmq-queue.provider');
    const svc = new BullMqBootstrapService(mkConfig(), null, null);

    const result = await svc.initialise();

    expect(result).toBeNull();
    const messages = warn.mock.calls.map((c) => c[0]);
    expect(messages).toContain('bullmq.disabled');
  });

  it('logs only one bullmq.redis.error warn even after 10 emitted errors', async () => {
    const created: EventEmitter[] = [];

    class FakeRedis extends EventEmitter {
      constructor() {
        super();
        created.push(this);
      }
      quit(): Promise<void> {
        return Promise.resolve();
      }
    }

    class FakeQueue {
      constructor(
        public name: string,
        public opts: unknown,
      ) {}
      close(): Promise<void> {
        return Promise.resolve();
      }
      add(): Promise<{ id: number }> {
        return Promise.resolve({ id: 1 });
      }
    }

    class FakeWorker {
      on(): void {
        /* noop */
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }

    jest.doMock('ioredis', () => ({ __esModule: true, default: FakeRedis }));
    jest.doMock('bullmq', () => ({
      __esModule: true,
      Queue: FakeQueue,
      Worker: FakeWorker,
    }));

    const { Logger } = await import('@nestjs/common');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const { BullMqBootstrapService } = await import('../bullmq-queue.provider');
    const svc = new BullMqBootstrapService(mkConfig(), null, null);

    await svc.initialise();

    expect(created.length).toBeGreaterThan(0);
    const conn = created[0];
    for (let i = 0; i < 10; i += 1) {
      conn.emit('error', new Error(`boom-${i}`));
    }

    const redisErrorCalls = warn.mock.calls.filter(([msg]) => msg === 'bullmq.redis.error');
    expect(redisErrorCalls).toHaveLength(1);
  });
});
