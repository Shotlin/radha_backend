import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * BE-40 — Ingredient explainer cache.
 *
 * Plain-language LLM explanations of food ingredients, cached forever
 * by (ingredient_slug, language). The same row is read by every
 * tenant — explanations are universal — so this table is deliberately
 * not tenant-scoped.
 *
 * The first request for a given (slug, language) burns LLM budget;
 * every subsequent request returns the cached row in <50ms. Bumping
 * `generated_by` (model name) does NOT invalidate — operators
 * re-generate by hand or via a future regenerate job.
 */
export const ingredientExplanations = pgTable(
  'ingredient_explanations',
  {
    ingredientSlug: text('ingredient_slug').notNull(),
    description: text('description').notNull(),
    healthConsiderations: text('health_considerations').notNull(),
    confidence: text('confidence').notNull(),
    language: text('language').notNull().default('en'),
    generatedBy: text('generated_by').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ingredientSlug, t.language] }),
    confidenceCheck: check(
      'ingredient_explanations_confidence_check',
      sql`${t.confidence} IN ('low','medium','high')`,
    ),
    bySlug: index('ingredient_explanations_slug_idx').on(t.ingredientSlug),
  }),
);

export type IngredientExplanationRow = typeof ingredientExplanations.$inferSelect;
export type NewIngredientExplanation = typeof ingredientExplanations.$inferInsert;

export type IngredientExplanationConfidence = 'low' | 'medium' | 'high';
