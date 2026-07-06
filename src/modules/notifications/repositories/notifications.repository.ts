import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewNotification, NotificationRow, notifications } from '@/db/schema/notifications';

import type { NotificationCategory } from '../types/notification.types';

/**
 * BE-24 — `notifications` table data access.
 *
 * Wraps `BaseRepository` for vanilla CRUD + adds:
 *   - `findByIdForUser`     — user-scoped point-read
 *   - `listForUser`         — cursor pagination over the inbox
 *   - `markRead` / `markAllRead`
 *   - `findDueScheduled`    — BullMQ enqueue helper
 *   - `findExpiredOlderThan` — data retention sweep
 */
@Injectable()
export class NotificationsRepository extends BaseRepository<
  typeof notifications,
  NotificationRow,
  NewNotification,
  Partial<NewNotification>
> {
  constructor(db: DbService) {
    super(db.getDb(), notifications, 'notifications');
  }

  async findByIdForUser(id: string, userId: string): Promise<NotificationRow | null> {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .limit(1);
    return (row as NotificationRow | undefined) ?? null;
  }

  async listForUser(
    userId: string,
    tenantId: string,
    filters: {
      cursor?: { createdAt: Date; id: string };
      limit: number;
      category?: NotificationCategory;
      unreadOnly?: boolean;
    },
  ): Promise<NotificationRow[]> {
    const conditions = [eq(notifications.userId, userId), eq(notifications.tenantId, tenantId)];
    if (filters.category) {
      conditions.push(eq(notifications.category, filters.category));
    }
    if (filters.unreadOnly) {
      conditions.push(eq(notifications.isRead, false));
    }
    if (filters.cursor) {
      // Cursor is `(createdAt desc, id desc)` — strict less-than on the
      // tuple gives a stable seek without ORDER BY tie-break ambiguity.
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${filters.cursor.createdAt.toISOString()}::timestamptz, ${filters.cursor.id}::uuid)`,
      );
    }

    return (await this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(filters.limit + 1)) as NotificationRow[];
  }

  async markRead(id: string, userId: string, now: Date): Promise<boolean> {
    const result = await this.db
      .update(notifications)
      .set({ isRead: true, readAt: now, updatedAt: now })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          eq(notifications.isRead, false),
        ),
      )
      .returning({ id: notifications.id });
    return (result as Array<unknown>).length > 0;
  }

  async markAllRead(userId: string, now: Date): Promise<number> {
    const result = await this.db
      .update(notifications)
      .set({ isRead: true, readAt: now, updatedAt: now })
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)))
      .returning({ id: notifications.id });
    return (result as Array<unknown>).length;
  }

  /** BullMQ enqueue helper — pulls scheduled rows whose time has come. */
  async findDueScheduled(now: Date, limit = 200): Promise<NotificationRow[]> {
    return (await this.db
      .select()
      .from(notifications)
      .where(
        and(
          isNull(notifications.sentAt),
          isNull(notifications.failedAt),
          lte(notifications.scheduledFor, now),
        ),
      )
      .orderBy(notifications.scheduledFor)
      .limit(limit)) as NotificationRow[];
  }

  /** Data retention — read notifications older than threshold. */
  async findExpiredOlderThan(
    cutoff: Date,
    onlyRead = true,
    limit = 1_000,
  ): Promise<NotificationRow[]> {
    const conditions = [lt(notifications.createdAt, cutoff)];
    if (onlyRead) conditions.push(eq(notifications.isRead, true));

    return (await this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .limit(limit)) as NotificationRow[];
  }

  async deleteOlderThan(cutoff: Date, onlyRead = true): Promise<number> {
    const conditions = [lt(notifications.createdAt, cutoff)];
    if (onlyRead) conditions.push(eq(notifications.isRead, true));

    const result = await this.db
      .delete(notifications)
      .where(and(...conditions))
      .returning({ id: notifications.id });
    return (result as Array<unknown>).length;
  }

  async incrementAttempts(id: string, tx?: Transaction): Promise<void> {
    const scope = tx ?? this.db;
    await scope
      .update(notifications)
      .set({
        attemptCount: sql`${notifications.attemptCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(notifications.id, id));
  }

  async getUnreadCount(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
    return Number(row?.count ?? 0);
  }

  async countSentInWindow(
    from: Date,
    to: Date,
    channel: 'email' | 'sms' | 'push' | 'in-app',
  ): Promise<number> {
    const col =
      channel === 'email'
        ? notifications.emailStatus
        : channel === 'sms'
          ? notifications.smsStatus
          : channel === 'push'
            ? notifications.pushStatus
            : notifications.inAppStatus;

    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          gte(notifications.createdAt, from),
          lt(notifications.createdAt, to),
          inArray(col, ['sent', 'delivered', 'read']),
        ),
      );
    return Number(row?.count ?? 0);
  }
}
