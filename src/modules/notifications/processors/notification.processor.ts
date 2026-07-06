import { Injectable, Logger } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { MetricsService } from '@/observability/metrics.service';

import { NotificationsService } from '../notifications.service';
import type { NotificationJobPayload } from '../types/notification.types';

/**
 * BE-24 — BullMQ processor for the `notifications` queue.
 *
 * The processor is a pure adapter: it receives the job payload,
 * delegates to `NotificationsService.dispatchNow`, and lets BullMQ
 * apply the retry/backoff schedule configured by the producer.
 *
 * The class is framework-agnostic on purpose. `JobsModule` (BE-24
 * BullMQ wiring) decides whether to register it as a `@Processor()`
 * via `@nestjs/bullmq` or as a plain Worker — both end up calling
 * `process(job)` with the same shape.
 *
 * Failures bubble up so BullMQ can apply backoff. After
 * `attempts` exhaustion the row's `failedAt` is already populated by
 * `dispatchNow`'s catch path.
 */
@Injectable()
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly appLogger: LoggerService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Standard BullMQ processor signature: `(job) => any`. Called by
   * the worker registered in `JobsModule`.
   */
  async process(job: {
    id?: string | number | null;
    data: NotificationJobPayload;
    attemptsMade?: number;
  }): Promise<{
    notificationId: string;
    status: 'sent' | 'failed';
    deliveredChannels: number;
  }> {
    const start = Date.now();
    const { notificationId } = job.data;

    this.appLogger.info('notification.processor.received', {
      jobId: job.id,
      notificationId,
      attempt: job.attemptsMade ?? 0,
    });

    try {
      const result = await this.notifications.dispatchNow(notificationId);
      this.metrics.counter(
        result.status === 'sent' ? 'notification.dispatch.success' : 'notification.dispatch.failed',
        1,
      );
      this.metrics.histogram('notification.dispatch.duration_ms', Date.now() - start);
      const deliveredChannels = result.channels.filter((c) => c.delivered).length;
      const status = result.status === 'sent' ? 'sent' : 'failed';

      this.appLogger.info('notification.processor.completed', {
        notificationId,
        status,
        deliveredChannels,
        durationMs: Date.now() - start,
      });

      // Throw on failure so BullMQ retries the job per the producer's
      // backoff config.
      if (status === 'failed') {
        throw new Error(`notification ${notificationId} failed all channels`);
      }

      return { notificationId, status, deliveredChannels };
    } catch (err) {
      this.metrics.counter('notification.dispatch.error', 1);
      this.logger.error('notification.processor.failed', {
        notificationId,
        attempt: job.attemptsMade ?? 0,
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    }
  }
}
