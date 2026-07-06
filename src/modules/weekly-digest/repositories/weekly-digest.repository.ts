import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  ConsumerWeeklyDigestRow,
  consumerWeeklyDigests,
  NewConsumerWeeklyDigest,
} from '@/db/schema/consumer-weekly-digests';
import { users } from '@/db/schema/users';

/**
 * BE-54 — `consumer_weekly_digests` data access.
 *
 * The cron asks four questions of this repository:
 *
 *   1. Which active Consumers should I produce a digest for? →
 *      `listActiveConsumers`. Pages on `(created_at, id)` so a
 *      large user base streams without a full table scan.
 *
 *   2. Has this user already had a digest for this week? →
 *      `existsForWeek`. The cron skips when true (idempotency).
 *
 *   3. Insert this digest. The unique index on
 *      (user_id, week_starting) is the safety net — even if two
 *      schedulers ran at once, only one row would survive.
 *
 *   4. After a successful FCM send, mark `delivered_at`. Failed
 *      sends leave it null, picked up later by the redelivery
 *      sweep.
 */
@Injectable()
export class WeeklyDigestRepository extends BaseRepository<
  typeof consumerWeeklyDigests,
  ConsumerWeeklyDigestRow,
  NewConsumerWeeklyDigest,
  Partial<NewConsumerWeeklyDigest>
> {
  constructor(db: DbService) {
    super(db.getDb(), consumerWeeklyDigests, 'consumer_weekly_digests');
  }

  /**
   * Stream active Consumer rows in batches. Cursor is the natural
   * `(createdAt, id)` ordering on the users table — stable for
   * pagination over a sweep that can take minutes.
   */
  async listActiveConsumers(
    cursor: { createdAt: Date; id: string } | null,
    limit: number,
  ): Promise<Array<{ id: string; tenantId: string | null; preferredLanguage: string }>> {
    const conditions = [
      eq(users.role, 'consumer'),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ];
    if (cursor) {
      conditions.push(
        sql`(${users.createdAt}, ${users.id}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const rows = await this.db
      .select({
        id: users.id,
        tenantId: users.tenantId,
        preferredLanguage: users.preferredLanguage,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(...conditions))
      .orderBy(users.createdAt, users.id)
      .limit(limit);

    return rows as Array<{
      id: string;
      tenantId: string | null;
      preferredLanguage: string;
      createdAt: Date;
    }>;
  }

  /**
   * Idempotency guard — true when this user already received a
   * digest for the given week. The cron checks this before doing
   * any expensive aggregation work.
   */
  async existsForWeek(userId: string, weekStarting: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: consumerWeeklyDigests.id })
      .from(consumerWeeklyDigests)
      .where(
        and(
          eq(consumerWeeklyDigests.userId, userId),
          eq(consumerWeeklyDigests.weekStarting, weekStarting),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async findByUserAndWeek(
    userId: string,
    weekStarting: string,
  ): Promise<ConsumerWeeklyDigestRow | null> {
    const [row] = await this.db
      .select()
      .from(consumerWeeklyDigests)
      .where(
        and(
          eq(consumerWeeklyDigests.userId, userId),
          eq(consumerWeeklyDigests.weekStarting, weekStarting),
        ),
      )
      .limit(1);
    return (row as ConsumerWeeklyDigestRow | undefined) ?? null;
  }

  /**
   * Most-recent digest for a user, newest week first. Backs the
   * on-demand `GET /weekly-digest` read so the screen always shows
   * the freshest summary the cron has produced.
   */
  async findLatestForUser(userId: string): Promise<ConsumerWeeklyDigestRow | null> {
    const [row] = await this.db
      .select()
      .from(consumerWeeklyDigests)
      .where(eq(consumerWeeklyDigests.userId, userId))
      .orderBy(sql`${consumerWeeklyDigests.weekStarting} DESC`)
      .limit(1);
    return (row as ConsumerWeeklyDigestRow | undefined) ?? null;
  }

  /**
   * Insert a digest row. `ON CONFLICT DO NOTHING` against the
   * unique index keeps the cron safe under concurrent schedulers
   * and replays — duplicates simply return null instead of
   * throwing.
   */
  async insertIfMissing(
    data: NewConsumerWeeklyDigest,
  ): Promise<ConsumerWeeklyDigestRow | null> {
    const [row] = await this.db
      .insert(consumerWeeklyDigests)
      .values(data)
      .onConflictDoNothing({
        target: [consumerWeeklyDigests.userId, consumerWeeklyDigests.weekStarting],
      })
      .returning();
    return (row as ConsumerWeeklyDigestRow | undefined) ?? null;
  }

  async markDelivered(id: string, deliveredAt: Date): Promise<void> {
    await this.db
      .update(consumerWeeklyDigests)
      .set({ deliveredAt })
      .where(eq(consumerWeeklyDigests.id, id));
  }

  /**
   * Redelivery sweep — pull rows that were inserted but never
   * delivered (FCM down, queue offline, etc.). Limited so the
   * caller can iterate.
   */
  async listUndelivered(limit = 200): Promise<ConsumerWeeklyDigestRow[]> {
    return (await this.db
      .select()
      .from(consumerWeeklyDigests)
      .where(isNull(consumerWeeklyDigests.deliveredAt))
      .orderBy(consumerWeeklyDigests.weekStarting, consumerWeeklyDigests.createdAt)
      .limit(limit)) as ConsumerWeeklyDigestRow[];
  }
}
