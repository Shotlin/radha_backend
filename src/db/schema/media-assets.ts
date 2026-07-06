import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * BE-13 — Media asset tracking.
 *
 * Every file Mobile_App or backend uploads to S3 carries a row here.
 * The lifecycle:
 *
 *   pending  → presigned URL issued, S3 object not yet there
 *   uploaded → BE confirmed object exists in S3 (HEAD success)
 *   processing → BE-23 (image processing) is generating variants
 *   ready    → variants live, CDN URLs valid
 *   failed   → upload didn't materialise / variant generation failed
 *   deleted  → soft-deleted (S3 object also removed)
 *
 * `tenant_id` is **nullable** to support OFF image migration into the
 * global product catalog (`ownerType = 'product'`, `ownerId = global product`,
 * `tenantId = NULL`). Tenant-private uploads always carry a non-null
 * tenant_id.
 *
 * `s3Key` is unique within `s3Bucket` — two media rows never share an
 * S3 location. The unique index is enforced at the DB level, not just
 * at the application level.
 */

export const mediaStatusEnum = pgEnum('media_status', [
  'pending',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'deleted',
]);

export const mediaOwnerTypeEnum = pgEnum('media_owner_type', [
  'product',
  'user',
  'tenant',
  'tmp',
  'image_ocr_fallback',
  'barcode_learning',
]);

export const mediaAssets = pgTable(
  'media_assets',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id'),

    ownerType: mediaOwnerTypeEnum('owner_type').notNull(),
    ownerId: uuid('owner_id'),

    s3Bucket: varchar('s3_bucket', { length: 100 }).notNull(),
    s3Key: varchar('s3_key', { length: 500 }).notNull(),

    contentType: varchar('content_type', { length: 100 }).notNull(),
    contentLength: integer('content_length').notNull(),

    status: mediaStatusEnum('status').notNull().default('pending'),

    /** Image variants — { thumbnail, medium, full } pointing at S3 keys (not URLs). */
    variants: jsonb('variants').$type<Record<string, string>>().default({}),

    width: integer('width'),
    height: integer('height'),

    /** External source URL when this row was migrated (e.g. OFF image). */
    sourceUrl: varchar('source_url', { length: 500 }),

    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),

    /** Who initiated the upload — user id or `'system'` for backend migrations. */
    uploadedBy: varchar('uploaded_by', { length: 64 }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    ownerIdx: index('media_owner_idx').on(t.ownerType, t.ownerId),
    statusIdx: index('media_status_idx').on(t.status),
    tenantIdx: index('media_tenant_idx').on(t.tenantId),
    s3KeyIdx: index('media_s3_key_idx').on(t.s3Key),
    pendingIdx: index('media_pending_idx').on(t.status, t.createdAt),
  }),
);

export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
