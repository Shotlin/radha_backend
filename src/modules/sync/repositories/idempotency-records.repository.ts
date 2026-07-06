import { Injectable } from '@nestjs/common';
import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  IdempotencyRecordRow,
  NewIdempotencyRecord,
  idempotencyRecords,
} from '@/db/schema/idempotency-records';

/**
 * BE-44 — Drizzle repository for `idempotency_records`.
 *
 * No business logic. The middleware reads via `findFreshByKey` so
 * expired rows are treated as a miss (the caller will then create a
 * fresh record).
 */
@Injectable()
export class IdempotencyRecordsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Lookup a non-expired record by primary key. Returns `null` when
   * the row doesn't exist or has passed `expires_at`.
   */
  async findFreshByKey(key: string): Promise<IdempotencyRecordRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.key, key), gt(idempotencyRecords.expiresAt, new Date())))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Look up by primary key without applying the freshness filter.
   * Useful for administrative diagnostics; the middleware uses
   * `findFreshByKey` so callers don't accidentally replay an expired
   * record.
   */
  async findByKey(key: string): Promise<IdempotencyRecordRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, key))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert a new record. Uses `ON CONFLICT (key) DO NOTHING` so two
   * concurrent first-time requests for the same key collapse into a
   * single persisted row — the second writer reads the winner back via
   * `findFreshByKey` on the next request.
   */
  async insertIfMissing(data: NewIdempotencyRecord): Promise<IdempotencyRecordRow | null> {
    const inserted = await this.db
      .getDb()
      .insert(idempotencyRecords)
      .values(data)
      .onConflictDoNothing({ target: idempotencyRecords.key })
      .returning();
    return inserted[0] ?? null;
  }

  /**
   * Bulk delete rows past their `expires_at`. The BE-31 cleanup job
   * calls this nightly.
   */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.db
      .getDb()
      .delete(idempotencyRecords)
      .where(lt(idempotencyRecords.expiresAt, now))
      .returning({ key: idempotencyRecords.key });
    return result.length;
  }

  /**
   * Diagnostic count of fresh records. Not used on the request hot
   * path; kept here so observability dashboards can query it via the
   * health module.
   */
  async countFresh(): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(idempotencyRecords)
      .where(gt(idempotencyRecords.expiresAt, new Date()));
    return rows[0]?.count ?? 0;
  }
}
