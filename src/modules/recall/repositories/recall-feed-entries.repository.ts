import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { NewRecallFeedEntry, RecallFeedEntryRow, recallFeedEntries } from '@/db/schema/recall';

/**
 * BE-39 — `recall_feed_entries` data access.
 *
 * Dedupe semantics: the upstream feeds don't always carry a stable
 * primary key, so we treat `(source, ean, batch_number, recalled_at,
 * reason)` as the natural identity. `findExisting()` is used by the
 * feed service to short-circuit re-inserts.
 */
@Injectable()
export class RecallFeedEntriesRepository {
  constructor(private readonly db: DbService) {}

  async findExisting(
    source: string,
    ean: string | null,
    batchNumber: string | null,
    recalledAt: string,
    reason: string,
  ): Promise<RecallFeedEntryRow | null> {
    const conditions = [
      eq(recallFeedEntries.source, source),
      eq(recallFeedEntries.recalledAt, recalledAt),
      eq(recallFeedEntries.reason, reason),
      ean !== null ? eq(recallFeedEntries.ean, ean) : isNull(recallFeedEntries.ean),
      batchNumber !== null
        ? eq(recallFeedEntries.batchNumber, batchNumber)
        : isNull(recallFeedEntries.batchNumber),
    ];
    const rows = await this.db
      .getDb()
      .select()
      .from(recallFeedEntries)
      .where(and(...conditions))
      .limit(1);
    return (rows[0] as RecallFeedEntryRow | undefined) ?? null;
  }

  async create(data: NewRecallFeedEntry): Promise<RecallFeedEntryRow> {
    const [row] = await this.db.getDb().insert(recallFeedEntries).values(data).returning();
    return row as RecallFeedEntryRow;
  }

  async findById(id: string): Promise<RecallFeedEntryRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(recallFeedEntries)
      .where(eq(recallFeedEntries.id, id))
      .limit(1);
    return (rows[0] as RecallFeedEntryRow | undefined) ?? null;
  }

  async countBySource(source: string): Promise<number> {
    const result = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(recallFeedEntries)
      .where(eq(recallFeedEntries.source, source));
    return result[0]?.count ?? 0;
  }
}
