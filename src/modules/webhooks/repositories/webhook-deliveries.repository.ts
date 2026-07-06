import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, lt, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  NewWebhookDelivery,
  WebhookDeliveryRow,
  webhookDeliveries,
  webhookEndpoints,
} from '@/db/schema/webhooks';

import type { DeliveryStatus } from '../dto/replay-delivery.dto';

/**
 * BE-50 — Drizzle repository for `webhook_deliveries`.
 *
 * Owns the queries the delivery + retry pipelines need:
 *   - bulk insert of pending rows during fan-out,
 *   - status transitions (pending → succeeded / failed),
 *   - "due for retry" pull for the cron sweeper,
 *   - tenant-scoped listing for the dashboard,
 *   - replay (reset to pending and re-arm `next_retry_at`).
 */
@Injectable()
export class WebhookDeliveriesRepository {
  constructor(private readonly db: DbService) {}

  /** Insert a single pending row. Used by `WebhookEmitterService`. */
  async create(data: NewWebhookDelivery): Promise<WebhookDeliveryRow> {
    const [row] = await this.db.getDb().insert(webhookDeliveries).values(data).returning();
    return row;
  }

  /** Bulk insert: returns every inserted row in input order. */
  async createMany(rows: NewWebhookDelivery[]): Promise<WebhookDeliveryRow[]> {
    if (rows.length === 0) return [];
    return this.db.getDb().insert(webhookDeliveries).values(rows).returning();
  }

  /** Fetch a delivery by id (no tenancy filter — used by worker). */
  async findById(id: string): Promise<WebhookDeliveryRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Tenant-scoped listing for the dashboard. Joins the endpoint to
   * filter by tenant, optionally narrows by status, sorts newest
   * first, applies a default limit of 50.
   */
  async listForTenant(
    tenantId: string,
    opts: { status?: DeliveryStatus; limit?: number } = {},
  ): Promise<WebhookDeliveryRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const conditions = [eq(webhookEndpoints.tenantId, tenantId)];
    if (opts.status) conditions.push(eq(webhookDeliveries.status, opts.status));

    const rows = await this.db
      .getDb()
      .select({ delivery: webhookDeliveries })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);

    return rows.map((r) => r.delivery);
  }

  /** Tenant-scoped lookup for replay — confirms the caller owns it. */
  async findByIdForTenant(id: string, tenantId: string): Promise<WebhookDeliveryRow | null> {
    const rows = await this.db
      .getDb()
      .select({ delivery: webhookDeliveries })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(and(eq(webhookDeliveries.id, id), eq(webhookEndpoints.tenantId, tenantId)))
      .limit(1);
    return rows[0]?.delivery ?? null;
  }

  /**
   * Pull deliveries the retry sweeper should re-attempt:
   *   - status pending or failed,
   *   - `attempts < 5` (under cap),
   *   - `next_retry_at <= now` OR `next_retry_at IS NULL`
   *     (first-attempt rows have no scheduled time yet),
   *   - `expires_at > now` (don't waste cycles on TTLed rows).
   *
   * Sort ascending so the oldest due rows go first, bounded by
   * `limit` so a single tick doesn't try to flush a huge backlog.
   */
  async findDueForRetry(now: Date, limit: number): Promise<WebhookDeliveryRow[]> {
    return this.db
      .getDb()
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          inArray(webhookDeliveries.status, ['pending', 'failed']),
          lt(webhookDeliveries.attempts, 5),
          sql`(${webhookDeliveries.nextRetryAt} is null or ${webhookDeliveries.nextRetryAt} <= ${now})`,
          sql`${webhookDeliveries.expiresAt} > ${now}`,
        ),
      )
      .orderBy(asc(webhookDeliveries.createdAt))
      .limit(Math.max(1, limit));
  }

  /** Mark a delivery as successfully sent. */
  async markSucceeded(id: string, statusCode: number, attemptedAt: Date): Promise<void> {
    await this.db
      .getDb()
      .update(webhookDeliveries)
      .set({
        status: 'succeeded',
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastAttemptAt: attemptedAt,
        lastStatusCode: statusCode,
        lastError: null,
        nextRetryAt: null,
      })
      .where(eq(webhookDeliveries.id, id));
  }

  /**
   * Increment attempts after a failed try. The caller computes the
   * next backoff window; if it's `null` the row has hit the 5-attempt
   * cap and is permanently failed.
   */
  async markRetry(
    id: string,
    opts: {
      attemptedAt: Date;
      statusCode: number | null;
      error: string;
      nextRetryAt: Date | null;
      permanentlyFailed: boolean;
    },
  ): Promise<void> {
    await this.db
      .getDb()
      .update(webhookDeliveries)
      .set({
        status: opts.permanentlyFailed ? 'failed' : 'pending',
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        lastAttemptAt: opts.attemptedAt,
        lastStatusCode: opts.statusCode,
        lastError: opts.error.slice(0, 2000),
        nextRetryAt: opts.nextRetryAt,
      })
      .where(eq(webhookDeliveries.id, id));
  }

  /**
   * Replay: reset a delivery to pending with attempts=0 so the next
   * cron tick (or a direct delivery call) re-fires it immediately.
   * Re-uses the original `id` so the receiver's idempotency key
   * still matches.
   */
  async resetForReplay(id: string): Promise<WebhookDeliveryRow | null> {
    const [row] = await this.db
      .getDb()
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        lastStatusCode: null,
        nextRetryAt: null,
      })
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return row ?? null;
  }

  /** Cleanup helper — used by the BE-31 family sweep. */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.db
      .getDb()
      .delete(webhookDeliveries)
      .where(lte(webhookDeliveries.expiresAt, now))
      .returning({ id: webhookDeliveries.id });
    return result.length;
  }
}
