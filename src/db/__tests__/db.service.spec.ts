import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import { MetricsService } from '@/observability/metrics.service';

import { DbService } from '../db.service';

/**
 * The DbService unit tests stay isolated from a real Postgres by
 * stubbing the connection factory the constructor would otherwise
 * use. We test contract behaviour:
 *   - typed errors when the connection is not initialised,
 *   - error-code translation on transaction failures,
 *   - metrics emission on commit and rollback.
 */
describe('DbService', () => {
  const baseConfig = {
    database: {
      host: 'h',
      port: 5432,
      name: 'n',
      user: 'u',
      password: 'p',
      ssl: false,
      schema: 'public',
      maxConnections: 10,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    },
    isDevelopment: true,
  } as unknown as ConfigService;

  const buildService = (): {
    svc: DbService;
    logger: LoggerService;
    metrics: { counter: jest.Mock; gauge: jest.Mock; histogram: jest.Mock };
  } => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;
    const metrics = {
      counter: jest.fn(),
      gauge: jest.fn(),
      histogram: jest.fn(),
    };
    return {
      svc: new DbService(baseConfig, logger, metrics as unknown as MetricsService),
      logger,
      metrics,
    };
  };

  it('throws DATABASE_CONNECTION_FAILED when there is no active connection', () => {
    const { svc } = buildService();
    // The constructor now eagerly creates the (lazy) pool, so getDb() works
    // after construction. Simulate a failed/closed connection to exercise the
    // typed-error guard in getDb().
    (svc as unknown as { connection: unknown }).connection = null;
    expect(() => svc.getDb()).toThrow(BusinessException);
    try {
      svc.getDb();
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.DATABASE_CONNECTION_FAILED);
    }
  });

  it('ping returns false when the pool is not initialised', async () => {
    const { svc } = buildService();
    expect(await svc.ping()).toBe(false);
  });

  it('translates statement-timeout errors to DATABASE_TIMEOUT', async () => {
    const { svc, metrics } = buildService();
    // Inject a fake connection so transaction can proceed
    const failingDb = {
      transaction: async <T>(_cb: (tx: unknown) => Promise<T>): Promise<T> => {
        const err = new Error('canceling statement due to statement timeout');
        (err as Error & { code?: string }).code = '57014';
        throw err;
      },
    };
    (svc as unknown as { connection: unknown }).connection = {
      db: failingDb,
      client: {} as unknown,
      close: async () => undefined,
    };

    await expect(svc.transaction(async () => 0)).rejects.toMatchObject({
      code: ErrorCode.DATABASE_TIMEOUT,
    });
    expect(metrics.counter).toHaveBeenCalledWith('db.transaction.rolled_back', 1);
  });

  it('translates deadlock errors to DATABASE_DEADLOCK', async () => {
    const { svc } = buildService();
    const failingDb = {
      transaction: async <T>(_cb: (tx: unknown) => Promise<T>): Promise<T> => {
        const err = new Error('deadlock detected');
        (err as Error & { code?: string }).code = '40P01';
        throw err;
      },
    };
    (svc as unknown as { connection: unknown }).connection = {
      db: failingDb,
      client: {} as unknown,
      close: async () => undefined,
    };
    await expect(svc.transaction(async () => 0)).rejects.toMatchObject({
      code: ErrorCode.DATABASE_DEADLOCK,
    });
  });

  it('emits committed metrics on a successful transaction', async () => {
    const { svc, metrics } = buildService();
    const successfulDb = {
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
    };
    (svc as unknown as { connection: unknown }).connection = {
      db: successfulDb,
      client: {} as unknown,
      close: async () => undefined,
    };

    const result = await svc.transaction(async () => 'ok');
    expect(result).toBe('ok');
    expect(metrics.counter).toHaveBeenCalledWith('db.transaction.committed', 1);
    expect(metrics.histogram).toHaveBeenCalledWith(
      'db.transaction.duration_ms',
      expect.any(Number),
    );
  });
});
