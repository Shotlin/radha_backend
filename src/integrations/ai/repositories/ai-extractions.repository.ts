import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { AiExtractionRow, NewAiExtraction, aiExtractions } from '@/db/schema/ai';

/**
 * BE-22 — Repository for the per-call audit trail.
 *
 * Writes are append-only — we never mutate an existing row. A failure
 * to persist must NOT propagate upward and break the user request, so
 * the orchestrator catches and logs but doesn't rethrow.
 */
@Injectable()
export class AiExtractionsRepository extends BaseRepository<
  typeof aiExtractions,
  AiExtractionRow,
  NewAiExtraction,
  Partial<NewAiExtraction>
> {
  constructor(db: DbService) {
    super(db.getDb(), aiExtractions, 'ai_extractions');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<AiExtractionRow | null> {
    const [row] = await this.db
      .select()
      .from(aiExtractions)
      .where(
        and(
          eq(aiExtractions.id, id),
          eq(aiExtractions.tenantId, tenantId),
          isNull(aiExtractions.deletedAt),
        ),
      )
      .limit(1);
    return ((row as AiExtractionRow | undefined) ?? null) as AiExtractionRow | null;
  }

  async listForSource(
    tenantId: string,
    sourceType: string,
    sourceId: string,
    limit = 20,
  ): Promise<AiExtractionRow[]> {
    return (await this.db
      .select()
      .from(aiExtractions)
      .where(
        and(
          eq(aiExtractions.tenantId, tenantId),
          eq(aiExtractions.sourceType, sourceType),
          eq(aiExtractions.sourceId, sourceId),
          isNull(aiExtractions.deletedAt),
        ),
      )
      .orderBy(desc(aiExtractions.createdAt))
      .limit(limit)) as AiExtractionRow[];
  }

  async recordSafely(data: NewAiExtraction, tx?: Transaction): Promise<AiExtractionRow | null> {
    try {
      return await this.create(data, tx);
    } catch {
      // Audit-log persistence failure must never break the user's
      // request. The structured logger has the entry as a fallback.
      return null;
    }
  }
}
