import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LoggerService } from '@/logging/logger.service';

import { WebhookDeliveriesRepository } from '../repositories/webhook-deliveries.repository';
import { WebhookDeliveryService } from '../services/webhook-delivery.service';

/**
 * BE-50 — Webhook retry sweeper.
 *
 * Schedule: every minute. Pulls a bounded batch of due deliveries
 * (status pending/failed, attempts < 5, `next_retry_at` <= now or
 * null, not expired) and asks `WebhookDeliveryService` to deliver
 * each one.
 *
 * The "<= now or null" clause means freshly-emitted rows fire on
 * the very next tick — Mobile_App and other receivers see latency
 * bounded by 60 seconds even if a delivery never failed in the
 * first place.
 *
 * Single-process safety: this job is registered on the scheduler
 * entrypoint only. If it ever runs in two processes simultaneously
 * we can move to a `FOR UPDATE SKIP LOCKED` pull, but until then
 * we rely on operational hygiene (`RUN_CRONS=1` flag).
 */
const BATCH_SIZE = 100;

@Injectable()
export class WebhookRetryJob {
  private readonly logger = new Logger(WebhookRetryJob.name);

  constructor(
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly deliveryService: WebhookDeliveryService,
    private readonly appLogger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'webhook-retry' })
  async run(): Promise<void> {
    const startedAt = new Date();
    let pulled = 0;
    let succeeded = 0;
    let failed = 0;
    let permanent = 0;
    let skipped = 0;

    try {
      const due = await this.deliveries.findDueForRetry(startedAt, BATCH_SIZE);
      pulled = due.length;
      if (pulled === 0) return;

      // Process sequentially to keep the failure mode predictable —
      // the receiver dictates the latency, and a parallel storm has
      // its own thundering-herd risk against a flaky endpoint.
      for (const delivery of due) {
        try {
          const result = await this.deliveryService.deliver(delivery.id);
          if (result.status === 'succeeded') succeeded += 1;
          else if (result.status === 'skipped') skipped += 1;
          else {
            failed += 1;
            if (result.permanentlyFailed) permanent += 1;
          }
        } catch (err) {
          // `deliver` already persists every outcome; an exception
          // here is unexpected. Log it loudly but keep going.
          this.logger.error(
            `webhook delivery ${delivery.id} threw out of deliver(): ${(err as Error).message}`,
          );
          failed += 1;
        }
      }
    } catch (err) {
      this.logger.error(`webhook-retry sweep failed: ${(err as Error).message}`);
      this.appLogger.error('webhook.retry.sweep_failed', {
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return;
    } finally {
      this.appLogger.info('webhook.retry.sweep_completed', {
        pulled,
        succeeded,
        failed,
        permanent,
        skipped,
        durationMs: Date.now() - startedAt.getTime(),
      });
    }
  }
}
