import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  NewWebhookEndpoint,
  WebhookEndpointRow,
  webhookEndpoints,
} from '@/db/schema/webhooks';

/**
 * BE-50 — Drizzle repository for `webhook_endpoints`.
 *
 * Purely a data-access object: no business rules (Pro tier check,
 * the 5-endpoint cap, secret generation) live here. Those are in
 * `WebhookEndpointsService`.
 *
 * Queries are tenant-scoped at the parameter level — every method
 * that touches a per-tenant row takes a `tenantId` so a buggy caller
 * can't accidentally read another tenant's endpoints.
 */
@Injectable()
export class WebhookEndpointsRepository {
  constructor(private readonly db: DbService) {}

  /** Insert a new endpoint row. Caller validates tier + cap first. */
  async create(data: NewWebhookEndpoint): Promise<WebhookEndpointRow> {
    const [row] = await this.db.getDb().insert(webhookEndpoints).values(data).returning();
    return row;
  }

  /** Total active endpoints owned by `tenantId`. Used for the 5-cap. */
  async countActiveByTenant(tenantId: string): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.isActive, true)));
    return rows[0]?.count ?? 0;
  }

  /** List every active endpoint for a tenant, newest first. */
  async listByTenant(tenantId: string): Promise<WebhookEndpointRow[]> {
    return this.db
      .getDb()
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.isActive, true)))
      .orderBy(sql`${webhookEndpoints.createdAt} desc`);
  }

  /** Look up a single endpoint scoped to its tenant. */
  async findByIdForTenant(id: string, tenantId: string): Promise<WebhookEndpointRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Look up a single endpoint by id (used by delivery worker). */
  async findById(id: string): Promise<WebhookEndpointRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Soft-delete: flip `is_active` to false. Keeps the audit trail
   * intact and lets historical deliveries continue to point at a
   * row. Hard-deletes are reserved for tenant cascades (see schema).
   */
  async deactivate(id: string, tenantId: string): Promise<boolean> {
    const result = await this.db
      .getDb()
      .update(webhookEndpoints)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.tenantId, tenantId)))
      .returning({ id: webhookEndpoints.id });
    return result.length > 0;
  }

  /**
   * Find every active endpoint subscribed to a given event for a
   * tenant. Used by `WebhookEmitterService` to fan out a single
   * event to every matching endpoint. Drizzle doesn't expose a
   * type-safe `array contains` helper here, so we drop to raw SQL.
   */
  async findActiveSubscribers(
    tenantId: string,
    eventName: string,
  ): Promise<WebhookEndpointRow[]> {
    return this.db
      .getDb()
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.tenantId, tenantId),
          eq(webhookEndpoints.isActive, true),
          sql`${eventName} = ANY (${webhookEndpoints.events})`,
        ),
      );
  }
}
