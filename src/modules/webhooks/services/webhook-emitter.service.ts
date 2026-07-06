import { Injectable, Logger } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import { WebhookEventName } from '../dto/webhook-events.types';
import { WebhookDeliveriesRepository } from '../repositories/webhook-deliveries.repository';
import { WebhookEndpointsRepository } from '../repositories/webhook-endpoints.repository';

/**
 * BE-50 — Public emitter API for the rest of the modules.
 *
 * Other modules (products, inventory, grn, tasks, scans) call
 * `emit(tenantId, event, payload)` whenever they finalise a
 * state-changing action. The emitter:
 *   1. Looks up every active endpoint subscribed to that event for
 *      the tenant.
 *   2. Inserts one `webhook_deliveries` row per matching endpoint
 *      with `status = 'pending'` and no `next_retry_at` (so the
 *      retry sweeper picks them up on its very next tick).
 *
 * The actual HTTP fan-out is handled later by the cron sweeper
 * calling into `WebhookDeliveryService` — keeping the emit cheap
 * and synchronous from the caller's perspective. A failure to
 * persist the delivery rows is logged but never bubbles to the
 * caller, so a webhook outage cannot break product creation /
 * inventory updates / etc.
 */
@Injectable()
export class WebhookEmitterService {
  private readonly logger = new Logger(WebhookEmitterService.name);

  constructor(
    private readonly endpoints: WebhookEndpointsRepository,
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly appLogger: LoggerService,
  ) {}

  /**
   * Fan out a single event to every matching endpoint for `tenantId`.
   *
   * Returns the number of pending delivery rows enqueued so callers
   * (and tests) can assert whether anything was actually scheduled.
   */
  async emit(
    tenantId: string,
    event: WebhookEventName,
    payload: Record<string, unknown>,
  ): Promise<number> {
    if (!tenantId) {
      // Defensive: a missing tenant id usually means the caller
      // forgot to plumb it through. Logging once at warn keeps the
      // signal visible without crashing the originating action.
      this.logger.warn(`webhook.emit ignored — no tenantId for event ${event}`);
      return 0;
    }

    let subscribers;
    try {
      subscribers = await this.endpoints.findActiveSubscribers(tenantId, event);
    } catch (err) {
      this.appLogger.error('webhook.emit.subscribers.lookup_failed', {
        error: { name: (err as Error).name, message: (err as Error).message },
        tenantId,
        event,
      });
      return 0;
    }

    if (subscribers.length === 0) return 0;

    const now = new Date();
    const rows = subscribers.map((endpoint) => ({
      endpointId: endpoint.id,
      eventName: event,
      payload,
      status: 'pending' as const,
      attempts: 0,
      // No `next_retry_at` set → cron picks it up immediately on the
      // next tick (handled by the "<= now() OR is null" SQL clause).
      nextRetryAt: null,
      lastAttemptAt: null,
      lastError: null,
      lastStatusCode: null,
    }));

    try {
      const inserted = await this.deliveries.createMany(rows);
      this.appLogger.info('webhook.emit', {
        tenantId,
        event,
        scheduled: inserted.length,
        timestamp: now.toISOString(),
      });
      return inserted.length;
    } catch (err) {
      this.appLogger.error('webhook.emit.insert_failed', {
        error: { name: (err as Error).name, message: (err as Error).message },
        tenantId,
        event,
        intended: rows.length,
      });
      return 0;
    }
  }
}
