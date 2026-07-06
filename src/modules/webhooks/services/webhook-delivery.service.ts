import { createHmac } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import { WebhookDeliveriesRepository } from '../repositories/webhook-deliveries.repository';
import { WebhookEndpointsRepository } from '../repositories/webhook-endpoints.repository';
import { validateWebhookUrl } from '../utils/url-validator.util';

/**
 * BE-50 — Outbound webhook delivery.
 *
 * Sole responsibility: take a single delivery row, sign it, POST it,
 * and persist the outcome. No retry scheduling logic of its own
 * beyond computing the next backoff window when a try fails — the
 * cron sweeper drives the retry loop.
 *
 * Backoff schedule (Req 52, exponential, capped at 1 hour):
 *   attempt 1 → wait 1m
 *   attempt 2 → wait 5m
 *   attempt 3 → wait 15m
 *   attempt 4 → wait 30m
 *   attempt 5 → wait 60m
 *   attempt 6 ⇒ permanent failure (delivery row stays at status=failed,
 *                attempts=5 indefinitely until the 7-day TTL).
 */

/** Backoff window indexed by `attempts` AFTER the failed try. */
export const RETRY_BACKOFF_MINUTES = [1, 5, 15, 30, 60] as const;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const DELIVERY_TIMEOUT_MS = 10_000;

export interface DeliveryAttemptResult {
  status: 'succeeded' | 'failed' | 'skipped';
  statusCode: number | null;
  error: string | null;
  permanentlyFailed: boolean;
  /** When `failed` & not permanent, the wall-clock time the next retry should fire at. */
  nextRetryAt: Date | null;
}

/** Minimal HTTP fetch contract — kept narrow so tests can substitute. */
export type HttpFetcher = (input: string, init: HttpFetchInit) => Promise<HttpFetchResponse>;

export interface HttpFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface HttpFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly endpoints: WebhookEndpointsRepository,
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly appLogger: LoggerService,
  ) {}

  /**
   * Deliver a single delivery row. Loads the endpoint fresh each
   * call (so a deactivation between schedule and fire takes effect
   * immediately) and persists the outcome before returning.
   *
   * Returns the structured outcome for tests / instrumentation; the
   * caller does not need to do any DB work — that's already happened.
   */
  async deliver(deliveryId: string, fetcher: HttpFetcher = defaultFetcher): Promise<DeliveryAttemptResult> {
    const delivery = await this.deliveries.findById(deliveryId);
    if (!delivery) {
      return {
        status: 'skipped',
        statusCode: null,
        error: 'Delivery not found',
        permanentlyFailed: false,
        nextRetryAt: null,
      };
    }

    const endpoint = await this.endpoints.findById(delivery.endpointId);
    if (!endpoint || !endpoint.isActive) {
      const result = this.failureResult(
        delivery.attempts,
        null,
        'Endpoint missing or deactivated',
      );
      await this.deliveries.markRetry(delivery.id, {
        attemptedAt: new Date(),
        statusCode: null,
        error: result.error ?? 'Endpoint missing or deactivated',
        nextRetryAt: result.nextRetryAt,
        permanentlyFailed: result.permanentlyFailed,
      });
      return result;
    }

    // SSRF guard: re-validate on every delivery, not just registration.
    // The receiver may have flipped DNS / config between create-time
    // and now, and we must never deliver to an internal target.
    const urlCheck = validateWebhookUrl(endpoint.url);
    if (!urlCheck.ok) {
      const reason = `URL refused by SSRF guard: ${urlCheck.reason ?? 'invalid'}`;
      const result = this.failureResult(delivery.attempts, null, reason);
      await this.deliveries.markRetry(delivery.id, {
        attemptedAt: new Date(),
        statusCode: null,
        error: reason,
        // SSRF reason will not change between attempts — fail
        // permanently rather than retrying the same bad URL.
        nextRetryAt: null,
        permanentlyFailed: true,
      });
      return { ...result, permanentlyFailed: true, nextRetryAt: null };
    }

    const body = JSON.stringify(delivery.payload);
    const signature = this.signHmacSha256(body, endpoint.secret);
    const attemptedAt = new Date();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    try {
      const res = await fetcher(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Radha-Signature': `sha256=${signature}`,
          'X-Radha-Event': delivery.eventName,
          'X-Radha-Delivery-Id': delivery.id,
        },
        body,
        signal: controller.signal,
      });

      if (res.ok) {
        await this.deliveries.markSucceeded(delivery.id, res.status, attemptedAt);
        this.appLogger.info('webhook.delivery.succeeded', {
          deliveryId: delivery.id,
          endpointId: endpoint.id,
          eventName: delivery.eventName,
          statusCode: res.status,
          attempt: delivery.attempts + 1,
        });
        return {
          status: 'succeeded',
          statusCode: res.status,
          error: null,
          permanentlyFailed: false,
          nextRetryAt: null,
        };
      }

      const errText = await res.text().catch(() => '');
      const reason = `HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`;
      const result = this.failureResult(delivery.attempts, res.status, reason);
      await this.deliveries.markRetry(delivery.id, {
        attemptedAt,
        statusCode: res.status,
        error: reason,
        nextRetryAt: result.nextRetryAt,
        permanentlyFailed: result.permanentlyFailed,
      });
      this.appLogger.warn('webhook.delivery.failed', {
        deliveryId: delivery.id,
        endpointId: endpoint.id,
        eventName: delivery.eventName,
        statusCode: res.status,
        attempt: delivery.attempts + 1,
        permanentlyFailed: result.permanentlyFailed,
      });
      return result;
    } catch (err) {
      const reason = (err as Error).message || 'Delivery failed';
      const result = this.failureResult(delivery.attempts, null, reason);
      await this.deliveries.markRetry(delivery.id, {
        attemptedAt,
        statusCode: null,
        error: reason,
        nextRetryAt: result.nextRetryAt,
        permanentlyFailed: result.permanentlyFailed,
      });
      this.logger.warn(
        `webhook delivery ${delivery.id} attempt ${delivery.attempts + 1} threw: ${reason}`,
      );
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Compute the structured failure result for an attempt. `attemptsBefore`
   * is the row's `attempts` value as we read it (i.e. *before* the
   * increment caused by this try).
   */
  private failureResult(
    attemptsBefore: number,
    statusCode: number | null,
    error: string,
  ): DeliveryAttemptResult {
    const newAttempts = attemptsBefore + 1;
    if (newAttempts >= MAX_DELIVERY_ATTEMPTS) {
      return {
        status: 'failed',
        statusCode,
        error,
        permanentlyFailed: true,
        nextRetryAt: null,
      };
    }

    // newAttempts is 1..4 here → use the corresponding backoff slot.
    const minutes = RETRY_BACKOFF_MINUTES[newAttempts - 1] ?? 60;
    const nextRetryAt = new Date(Date.now() + minutes * 60 * 1000);
    return {
      status: 'failed',
      statusCode,
      error,
      permanentlyFailed: false,
      nextRetryAt,
    };
  }

  /**
   * HMAC-SHA256 signing of the raw body. Public so the controller and
   * tests can verify the contract; receivers verify with the same
   * routine using their stored copy of the secret.
   */
  signHmacSha256(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  }
}

/**
 * Default fetch wrapper around the global `fetch`. Kept as a named
 * export so the cron worker / tests can replace it without touching
 * the service.
 */
export const defaultFetcher: HttpFetcher = async (url, init) => {
  // eslint-disable-next-line no-undef
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
};
