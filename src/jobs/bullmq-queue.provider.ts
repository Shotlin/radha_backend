import { Injectable, Logger, Optional } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import type { INotificationQueue } from '@/modules/notifications/notifications.service';
import { NotificationProcessor } from '@/modules/notifications/processors/notification.processor';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_JOB_DISPATCH,
} from '@/modules/notifications/types/notification.types';

interface RedisOptions {
  host: string;
  port: number;
  db: number;
  password?: string;
  tls?: Record<string, unknown>;
  keyPrefix: string;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
  connectTimeout: number;
  lazyConnect: boolean;
  retryStrategy: (times: number) => number | null;
}

/**
 * BE-24 — BullMQ queue + worker bootstrap.
 *
 * Lazy-loads `bullmq` + `ioredis` so the API process doesn't pay the
 * dependency cost when the dep isn't installed or Redis isn't
 * reachable. Surfaces a no-op queue (`null`) and the
 * `NotificationsService` falls through to its synchronous dispatch
 * path. The system stays correct, just slower.
 *
 * Resilience (mirrors BE-30 dashboard cache + BE-46 quota adapter):
 *   - bounded retry budget (5 attempts) via ioredis `retryStrategy`,
 *   - first connection error logs ONE `bullmq.redis.error` warn,
 *     subsequent errors are silently swallowed (no log loop),
 *   - on give-up the provider flips `degraded` permanently, closes
 *     queue+worker best-effort, and `initialise()` becomes a no-op.
 */
@Injectable()
export class BullMqBootstrapService {
  private readonly logger = new Logger(BullMqBootstrapService.name);
  private queue: INotificationQueue | null = null;
  private bullQueue: { close: () => Promise<void> } | null = null;
  private worker: { close: () => Promise<void> } | null = null;
  private redisConnection: { quit: () => Promise<unknown> } | null = null;
  private degraded = false;
  private loggedRedisError = false;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly processor: NotificationProcessor | null,
    @Optional() private readonly appLogger: LoggerService | null,
  ) {}

  async initialise(): Promise<INotificationQueue | null> {
    if (this.queue) return this.queue;
    if (this.degraded) return null;

    type BullModule = typeof import('bullmq');
    type IoRedisModule = typeof import('ioredis');

    const bull = (await import('bullmq').catch(() => null)) as BullModule | null;
    const ioredis = (await import('ioredis').catch(() => null)) as IoRedisModule | null;

    if (!bull || !ioredis) {
      this.degraded = true;
      this.logger.warn('bullmq.disabled', {
        reason: 'bullmq or ioredis not installed; falling back to sync dispatch',
      });
      return null;
    }

    try {
      const Redis = ioredis.default;
      const redisOpts = this.buildRedisOptions();
      const connection = new Redis(redisOpts);

      // Cap error logging to ONE warn per process — the retry budget
      // can otherwise produce an infinite log loop when Redis is down.
      connection.on('error', (err: Error) => {
        if (this.loggedRedisError) return;
        this.loggedRedisError = true;
        this.logger.warn('bullmq.redis.error', { message: err.message });
      });

      // `retryStrategy` returning null surfaces here. Flip degraded,
      // close queue+worker best-effort, and let consumers fall back
      // to the synchronous dispatch path.
      connection.on('end', () => {
        if (this.degraded) return;
        this.degraded = true;
        void this.tearDown();
      });

      this.redisConnection = connection as unknown as {
        quit: () => Promise<unknown>;
      };

      const queue = new bull.Queue(NOTIFICATIONS_QUEUE, {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 24 * 60 * 60, count: 5_000 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      });
      this.bullQueue = queue as unknown as { close: () => Promise<void> };
      this.queue = queue as unknown as INotificationQueue;

      if (this.processor) {
        const processor = this.processor;
        const worker = new bull.Worker(
          NOTIFICATIONS_QUEUE,
          async (job: { id?: string | number | null; data: unknown; attemptsMade?: number }) => {
            if (job.data && typeof job.data === 'object') {
              return processor.process(job as Parameters<typeof processor.process>[0]);
            }
            return null;
          },
          {
            connection,
            concurrency: 10,
            limiter: { max: 200, duration: 60_000 },
          },
        );
        worker.on('failed', (job: { id?: string | number | null } | undefined, err: Error) => {
          this.logger.error('bullmq.worker.failed', {
            jobId: job?.id,
            message: err.message,
          });
        });
        this.worker = worker as unknown as { close: () => Promise<void> };
        this.appLogger?.info('bullmq.worker.started', { queue: NOTIFICATIONS_QUEUE });
      }

      this.appLogger?.info('bullmq.queue.ready', {
        queue: NOTIFICATIONS_QUEUE,
        host: redisOpts.host,
        port: redisOpts.port,
      });
      return this.queue;
    } catch (err) {
      this.degraded = true;
      if (!this.loggedRedisError) {
        this.loggedRedisError = true;
        this.logger.error('bullmq.init.failed', err as Error);
      }
      this.queue = null;
      this.bullQueue = null;
      return null;
    }
  }

  jobName(): string {
    return NOTIFICATIONS_JOB_DISPATCH;
  }

  async shutdown(): Promise<void> {
    await this.tearDown();
    try {
      await this.redisConnection?.quit();
    } catch {
      /* best effort */
    }
    this.redisConnection = null;
  }

  /** Best-effort close of queue + worker. Sets `this.queue = null` so
   * consumers fall back to the synchronous dispatch path. */
  private async tearDown(): Promise<void> {
    try {
      await this.bullQueue?.close();
    } catch {
      /* best effort */
    }
    try {
      await this.worker?.close();
    } catch {
      /* best effort */
    }
    this.queue = null;
    this.bullQueue = null;
    this.worker = null;
  }

  private buildRedisOptions(): RedisOptions {
    const r = this.config.redis;
    return {
      host: r.host,
      port: r.port,
      db: r.db,
      password: r.password,
      tls: r.tls ? {} : undefined,
      keyPrefix: `${r.keyPrefix}bullmq:`,
      // BullMQ requires this to be `null` for blocking commands.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: 2_000,
      lazyConnect: false,
      // Bounded retry budget — give up after 5 attempts so the
      // ioredis loop doesn't run forever (and doesn't spam logs).
      retryStrategy: (times: number): number | null =>
        times > 5 ? null : Math.min(times * 500, 2_000),
    };
  }
}
