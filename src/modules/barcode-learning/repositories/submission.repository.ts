import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  BarcodeLearningStatus,
  BarcodeLearningSubmissionRow,
  NewBarcodeLearningSubmission,
  barcodeLearningSubmissions,
} from '@/db/schema/barcode-learning';

/**
 * BE-56 — Drizzle repository for `barcode_learning_submissions`.
 *
 * Pure data access — no business logic. The service decides who can
 * read/write what; this layer just knows how to translate ORM calls.
 */
@Injectable()
export class SubmissionRepository {
  constructor(private readonly db: DbService) {}

  /** Persist a new pending submission. */
  async create(data: NewBarcodeLearningSubmission): Promise<BarcodeLearningSubmissionRow> {
    const rows = await this.db
      .getDb()
      .insert(barcodeLearningSubmissions)
      .values(data)
      .returning();
    return rows[0];
  }

  /**
   * Find one row by id. Used by approve / reject paths to check the
   * row exists and isn't already moderated before mutating it.
   */
  async findById(id: string): Promise<BarcodeLearningSubmissionRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(barcodeLearningSubmissions)
      .where(eq(barcodeLearningSubmissions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List submissions matching `status` for the moderator queue.
   * Ordered oldest-first so the queue follows FIFO; offset/limit
   * paginate.
   */
  async listByStatus(
    status: BarcodeLearningStatus,
    options: { limit: number; offset: number },
  ): Promise<BarcodeLearningSubmissionRow[]> {
    return this.db
      .getDb()
      .select()
      .from(barcodeLearningSubmissions)
      .where(eq(barcodeLearningSubmissions.status, status))
      .orderBy(asc(barcodeLearningSubmissions.submittedAt))
      .limit(options.limit)
      .offset(options.offset);
  }

  /** Count rows matching `status`. Used to surface queue size in admin UI. */
  async countByStatus(status: BarcodeLearningStatus): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(barcodeLearningSubmissions)
      .where(eq(barcodeLearningSubmissions.status, status));
    return rows[0]?.count ?? 0;
  }

  /**
   * Update a submission's moderation outcome. Used by approve / reject
   * paths and the flag-tracker re-moderation flip. Returns the
   * updated row, or `null` when the row doesn't exist.
   */
  async updateStatus(
    id: string,
    patch: {
      status: BarcodeLearningStatus;
      moderatedAt?: Date | null;
      moderatedBy?: string | null;
      moderationNotes?: string | null;
    },
  ): Promise<BarcodeLearningSubmissionRow | null> {
    const updates: Partial<BarcodeLearningSubmissionRow> = { status: patch.status };
    if (patch.moderatedAt !== undefined) updates.moderatedAt = patch.moderatedAt;
    if (patch.moderatedBy !== undefined) updates.moderatedBy = patch.moderatedBy;
    if (patch.moderationNotes !== undefined) updates.moderationNotes = patch.moderationNotes;

    const rows = await this.db
      .getDb()
      .update(barcodeLearningSubmissions)
      .set(updates)
      .where(eq(barcodeLearningSubmissions.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Find the most recently approved submission for the given EAN.
   * Used by the flag-tracker — when 3 unique flags accrue for an EAN
   * we flip the latest approved submission back to `flagged` so the
   * moderator queue surfaces it again.
   */
  async findLatestApprovedByEan(ean: string): Promise<BarcodeLearningSubmissionRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(barcodeLearningSubmissions)
      .where(
        and(
          eq(barcodeLearningSubmissions.ean, ean),
          eq(barcodeLearningSubmissions.status, 'approved'),
        ),
      )
      .orderBy(
        desc(barcodeLearningSubmissions.moderatedAt),
        desc(barcodeLearningSubmissions.submittedAt),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Count submissions made by `userId` since `since` (exclusive). The
   * service uses this to enforce the 10-submissions-per-user-per-day
   * rate limit when no Redis-backed limiter is available.
   */
  async countByUserSince(userId: string, since: Date): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(barcodeLearningSubmissions)
      .where(
        and(
          eq(barcodeLearningSubmissions.submitterUserId, userId),
          gte(barcodeLearningSubmissions.submittedAt, since),
        ),
      );
    return rows[0]?.count ?? 0;
  }
}
