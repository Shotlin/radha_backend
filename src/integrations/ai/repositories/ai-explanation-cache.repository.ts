import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { AiExplanationCacheRow, NewAiExplanationCache, aiExplanationCache } from '@/db/schema/ai';

import type { AiOperation } from '../types/ai.types';

/**
 * BE-22 v2 ADDENDUM — Permanent cache for deterministic LLM outputs.
 *
 * Used by the ingredient explainer (Req 45) and the report-summary
 * service for canonical inputs. Caching is unconditional: if a row
 * exists for `(operation, cacheKey, locale, ruleVersion)` we reuse
 * it — same response, same cost (zero, since the LLM call is skipped).
 * Bumping `ruleVersion` invalidates every cached row in one go.
 */
@Injectable()
export class AiExplanationCacheRepository extends BaseRepository<
  typeof aiExplanationCache,
  AiExplanationCacheRow,
  NewAiExplanationCache,
  Partial<NewAiExplanationCache>
> {
  constructor(db: DbService) {
    super(db.getDb(), aiExplanationCache, 'ai_explanation_cache');
  }

  async findCached(
    operation: AiOperation,
    cacheKey: string,
    locale: string,
    ruleVersion: string,
  ): Promise<AiExplanationCacheRow | null> {
    const [row] = await this.db
      .select()
      .from(aiExplanationCache)
      .where(
        and(
          eq(aiExplanationCache.operation, operation),
          eq(aiExplanationCache.cacheKey, cacheKey),
          eq(aiExplanationCache.locale, locale),
          eq(aiExplanationCache.ruleVersion, ruleVersion),
        ),
      )
      .limit(1);
    return ((row as AiExplanationCacheRow | undefined) ?? null) as AiExplanationCacheRow | null;
  }

  async upsertCached(data: NewAiExplanationCache): Promise<AiExplanationCacheRow> {
    const [row] = (await this.db
      .insert(aiExplanationCache)
      .values(data)
      .onConflictDoUpdate({
        target: [
          aiExplanationCache.operation,
          aiExplanationCache.cacheKey,
          aiExplanationCache.locale,
          aiExplanationCache.ruleVersion,
        ],
        set: {
          response: data.response,
          responseText: data.responseText,
          provider: data.provider,
          cost: data.cost,
          tokensUsed: data.tokensUsed,
          updatedAt: new Date(),
        },
      })
      .returning()) as AiExplanationCacheRow[];
    return row;
  }

  async incrementHit(id: string): Promise<void> {
    await this.db
      .update(aiExplanationCache)
      .set({
        hitCount: sql`${aiExplanationCache.hitCount} + 1`,
        lastHitAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiExplanationCache.id, id));
  }
}
