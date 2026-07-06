import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  IngredientExplanationRow,
  NewIngredientExplanation,
  ingredientExplanations,
} from '@/db/schema/ingredient-explanations';

/**
 * BE-40 — Drizzle repository for the ingredient-explanations cache.
 *
 * No business logic — only database access. Writes are idempotent via
 * `ON CONFLICT DO NOTHING` so concurrent first-look requests for the
 * same `(slug, language)` collapse into a single persisted row.
 */
@Injectable()
export class IngredientExplanationRepository {
  constructor(private readonly db: DbService) {}

  async findOne(
    ingredientSlug: string,
    language: string,
  ): Promise<IngredientExplanationRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(ingredientExplanations)
      .where(
        and(
          eq(ingredientExplanations.ingredientSlug, ingredientSlug),
          eq(ingredientExplanations.language, language),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert with `ON CONFLICT DO NOTHING` so concurrent generators for
   * the same `(slug, language)` produce a single row. When a conflict
   * occurs we re-read the existing row so callers always get a
   * consistent return value.
   */
  async insertIfMissing(
    data: NewIngredientExplanation,
  ): Promise<IngredientExplanationRow> {
    const inserted = await this.db
      .getDb()
      .insert(ingredientExplanations)
      .values(data)
      .onConflictDoNothing({
        target: [ingredientExplanations.ingredientSlug, ingredientExplanations.language],
      })
      .returning();

    if (inserted[0]) return inserted[0];

    // Conflict path — another writer beat us. Return the row that
    // actually landed.
    const existing = await this.findOne(data.ingredientSlug, data.language ?? 'en');
    if (!existing) {
      // Shouldn't happen — the conflict implies a row exists. Fail
      // closed so callers don't silently corrupt state.
      throw new Error(
        `ingredient_explanations row missing after conflict for (${data.ingredientSlug}, ${data.language ?? 'en'})`,
      );
    }
    return existing;
  }
}
