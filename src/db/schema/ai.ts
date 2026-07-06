import { sql } from 'drizzle-orm';
import {
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { baseColumns, softDeleteColumn } from './_base';

/**
 * BE-22 — AI/OCR wrapper persistence layer.
 *
 * Three tables, one file (mirrors BE-18's `expiry.ts`):
 *
 *   - `ai_extractions`   — per-call audit trail of every AI/OCR
 *                          invocation (mobile pre-extracted, AWS
 *                          Rekognition, Google Cloud Vision, OpenAI
 *                          LLM, OFF text). Used for debug, retraining
 *                          datasets, compliance.
 *   - `ai_usage_log`     — append-only ledger for tenant-scoped cost
 *                          and quota enforcement. Pre-aggregated with
 *                          `year_month` and `year_month_day` columns
 *                          so the hot path (`UsageTrackerService.checkLimit`)
 *                          becomes a single index lookup.
 *   - `ai_explanation_cache` — permanent cache for deterministic LLM
 *                          outputs (Req 45 ingredient explainer). The
 *                          spec promises "permanent caching of
 *                          explanations" so we key by `(operation,
 *                          cache_key)` and never expire — only
 *                          `rule_version` bumps invalidate them.
 *
 * Tenant scoping is mandatory for `ai_extractions` and `ai_usage_log`.
 * `ai_explanation_cache` is intentionally global because the same
 * ingredient slug yields the same explanation regardless of tenant —
 * caching it tenant-by-tenant would multiply cost by N.
 */

export const aiOperationEnum = pgEnum('ai_operation', [
  'ocr-expiry',
  'ocr-batch',
  'ocr-text',
  'label-analysis',
  'image-fallback',
  'report-summary',
  'product-enrichment',
  'image-classification',
  'ingredient-explanation',
]);

export const aiProviderEnum = pgEnum('ai_provider', [
  'mlkit',
  'rekognition',
  'google-vision',
  'openai',
  'gemini',
  'nvidia',
  'claude',
  'openfoodfacts',
  'mock',
]);

export const aiExtractions = pgTable(
  'ai_extractions',
  {
    ...baseColumns,
    ...softDeleteColumn,
    tenantId: uuid('tenant_id').notNull(),

    operation: aiOperationEnum('operation').notNull(),
    provider: aiProviderEnum('provider').notNull(),

    /** `'media' | 'text' | 'product' | 'ingredient'` */
    sourceType: varchar('source_type', { length: 32 }),
    sourceId: uuid('source_id'),

    /**
     * Boolean stored as varchar('5') so the BE-22 spec's example queries
     * (`WHERE success = 'true'`) keep working without forcing a special
     * boolean migration. The underlying state is still a tri-state
     * 'true' | 'false' | 'partial'.
     */
    success: varchar('success', { length: 8 }).notNull().default('false'),

    extractedText: varchar('extracted_text', { length: 5000 }),
    extractedData: jsonb('extracted_data').$type<Record<string, unknown>>().default({}),
    confidence: decimal('confidence', { precision: 4, scale: 3 }),

    durationMs: integer('duration_ms').notNull().default(0),
    cost: decimal('cost', { precision: 10, scale: 6 }).notNull().default('0'),
    tokensUsed: integer('tokens_used'),

    userId: uuid('user_id'),
    requestId: varchar('request_id', { length: 64 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantOpIdx: index('ai_extractions_tenant_op_idx').on(t.tenantId, t.operation),
    sourceIdx: index('ai_extractions_source_idx').on(t.sourceType, t.sourceId),
    providerIdx: index('ai_extractions_provider_idx').on(t.provider),
    createdAtIdx: index('ai_extractions_created_at_idx').on(t.createdAt),
  }),
);
export type AiExtractionRow = typeof aiExtractions.$inferSelect;
export type NewAiExtraction = typeof aiExtractions.$inferInsert;

export const aiUsageLog = pgTable(
  'ai_usage_log',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id'),

    operation: aiOperationEnum('operation').notNull(),
    provider: aiProviderEnum('provider').notNull(),

    cost: decimal('cost', { precision: 10, scale: 6 }).notNull().default('0'),
    durationMs: integer('duration_ms').notNull().default(0),
    tokensUsed: integer('tokens_used').notNull().default(0),

    success: varchar('success', { length: 8 }).notNull().default('true'),

    /** Pre-aggregated bucket columns — every query uses one of these. */
    yearMonth: varchar('year_month', { length: 7 }).notNull(),
    yearMonthDay: varchar('year_month_day', { length: 10 }).notNull(),

    resourceId: uuid('resource_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantMonthOpIdx: index('ai_usage_tenant_month_op_idx').on(
      t.tenantId,
      t.yearMonth,
      t.operation,
    ),
    tenantDayIdx: index('ai_usage_tenant_day_idx').on(t.tenantId, t.yearMonthDay),
    providerIdx: index('ai_usage_provider_idx').on(t.provider),
  }),
);
export type AiUsageRow = typeof aiUsageLog.$inferSelect;
export type NewAiUsage = typeof aiUsageLog.$inferInsert;

export const aiExplanationCache = pgTable(
  'ai_explanation_cache',
  {
    ...baseColumns,
    operation: aiOperationEnum('operation').notNull(),
    cacheKey: varchar('cache_key', { length: 255 }).notNull(),
    locale: varchar('locale', { length: 16 }).notNull().default('en'),

    /** Bumping this invalidates every cached row that doesn't carry the new version. */
    ruleVersion: varchar('rule_version', { length: 32 }).notNull().default('1.0.0'),

    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    responseText: varchar('response_text', { length: 8000 }),

    provider: aiProviderEnum('provider').notNull(),
    cost: decimal('cost', { precision: 10, scale: 6 }).notNull().default('0'),
    tokensUsed: integer('tokens_used').notNull().default(0),

    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    keyUniq: uniqueIndex('ai_explanation_cache_key_uniq').on(
      t.operation,
      t.cacheKey,
      t.locale,
      t.ruleVersion,
    ),
    operationIdx: index('ai_explanation_cache_operation_idx').on(t.operation),
  }),
);
export type AiExplanationCacheRow = typeof aiExplanationCache.$inferSelect;
export type NewAiExplanationCache = typeof aiExplanationCache.$inferInsert;
