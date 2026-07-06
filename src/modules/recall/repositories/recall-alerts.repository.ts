import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  NewRecallAlert,
  RecallAlertRow,
  RecallFeedEntryRow,
  recallAlerts,
  recallFeedEntries,
} from '@/db/schema/recall';
import { savedProducts } from '@/db/schema/saved-products';
import { users } from '@/db/schema/users';

import type { SavedProductMatch } from '../types/recall.types';

/**
 * BE-39 — `recall_alerts` data access.
 *
 * Two access patterns:
 *
 *   - **Sweep path** — the cron persists one alert per match. The
 *     write goes through `createIfMissing()` which leans on the
 *     UNIQUE(user_id, recall_feed_entry_id, saved_product_id)
 *     constraint via `ON CONFLICT DO NOTHING`. The result is `null`
 *     when the row already existed (the sweep skipped a duplicate),
 *     letting the caller suppress the FCM resend.
 *
 *   - **Read path** — the Mobile_App lists alerts per-user with a
 *     simple `(created_at desc, id desc)` cursor. We join to the
 *     feed entry so the API returns a single denormalised payload.
 */
@Injectable()
export class RecallAlertsRepository {
  constructor(private readonly db: DbService) {}

  async findMatchesByEan(ean: string): Promise<SavedProductMatch[]> {
    const rows = await this.db
      .getDb()
      .select({
        userId: savedProducts.userId,
        savedProductId: savedProducts.id,
        tenantId: users.tenantId,
      })
      .from(savedProducts)
      .innerJoin(users, eq(savedProducts.userId, users.id))
      .where(and(eq(savedProducts.barcode, ean), isNull(savedProducts.markedConsumedAt)));

    // Saved products are user-scoped (consumer feature); the tenant
    // scope comes from the owning user's personal tenant. Rows whose
    // user has no tenant assigned (e.g. brand-new signups before
    // BE-09 v2 personal-tenant bootstrap) are skipped — `recall_alerts`
    // requires `tenant_id` NOT NULL.
    return rows
      .filter((r): r is { userId: string; savedProductId: string; tenantId: string } =>
        Boolean(r.tenantId),
      )
      .map((r) => ({
        userId: r.userId,
        savedProductId: r.savedProductId,
        tenantId: r.tenantId,
      }));
  }

  async createIfMissing(data: NewRecallAlert): Promise<RecallAlertRow | null> {
    // Drizzle's `onConflictDoNothing` returns the inserted row OR an
    // empty array on conflict. The UNIQUE constraint covers the
    // dedupe target.
    const rows = await this.db
      .getDb()
      .insert(recallAlerts)
      .values(data)
      .onConflictDoNothing({
        target: [recallAlerts.userId, recallAlerts.recallFeedEntryId, recallAlerts.savedProductId],
      })
      .returning();
    return (rows[0] as RecallAlertRow | undefined) ?? null;
  }

  async findByIdForUser(id: string, userId: string): Promise<RecallAlertRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(recallAlerts)
      .where(and(eq(recallAlerts.id, id), eq(recallAlerts.userId, userId)))
      .limit(1);
    return (rows[0] as RecallAlertRow | undefined) ?? null;
  }

  async acknowledge(id: string, userId: string, now: Date): Promise<RecallAlertRow | null> {
    const rows = await this.db
      .getDb()
      .update(recallAlerts)
      .set({ acknowledgedAt: now })
      .where(and(eq(recallAlerts.id, id), eq(recallAlerts.userId, userId)))
      .returning();
    return (rows[0] as RecallAlertRow | undefined) ?? null;
  }

  async listForUser(
    userId: string,
    tenantId: string,
    filters: {
      cursor?: { createdAt: Date; id: string };
      limit: number;
      unacknowledgedOnly?: boolean;
    },
  ): Promise<Array<{ alert: RecallAlertRow; feedEntry: RecallFeedEntryRow }>> {
    const conditions = [eq(recallAlerts.userId, userId), eq(recallAlerts.tenantId, tenantId)];
    if (filters.unacknowledgedOnly) {
      conditions.push(isNull(recallAlerts.acknowledgedAt));
    }
    if (filters.cursor) {
      conditions.push(
        sql`(${recallAlerts.createdAt}, ${recallAlerts.id}) < (${filters.cursor.createdAt.toISOString()}::timestamptz, ${filters.cursor.id}::uuid)`,
      );
    }

    const rows = await this.db
      .getDb()
      .select({
        alert: recallAlerts,
        feedEntry: recallFeedEntries,
      })
      .from(recallAlerts)
      .innerJoin(recallFeedEntries, eq(recallAlerts.recallFeedEntryId, recallFeedEntries.id))
      .where(and(...conditions))
      .orderBy(desc(recallAlerts.createdAt), desc(recallAlerts.id))
      .limit(filters.limit + 1);

    return rows as Array<{ alert: RecallAlertRow; feedEntry: RecallFeedEntryRow }>;
  }
}
