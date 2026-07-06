import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { MediaAssetRow, NewMediaAsset, mediaAssets } from '@/db/schema/media-assets';

@Injectable()
export class MediaRepository extends BaseRepository<
  typeof mediaAssets,
  MediaAssetRow,
  NewMediaAsset,
  Partial<NewMediaAsset>
> {
  constructor(db: DbService) {
    super(db.getDb(), mediaAssets, 'media_assets');
  }

  async findVisibleById(id: string, tenantId: string | null): Promise<MediaAssetRow | null> {
    const tenantCondition = tenantId
      ? or(eq(mediaAssets.tenantId, tenantId), isNull(mediaAssets.tenantId))
      : isNull(mediaAssets.tenantId);
    const [row] = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, id), tenantCondition, isNull(mediaAssets.deletedAt)))
      .limit(1);
    return (row as MediaAssetRow | undefined) ?? null;
  }

  async findByOwner(
    ownerType: MediaAssetRow['ownerType'],
    ownerId: string,
    tenantId: string | null,
  ): Promise<MediaAssetRow[]> {
    const tenantCondition = tenantId
      ? or(eq(mediaAssets.tenantId, tenantId), isNull(mediaAssets.tenantId))
      : isNull(mediaAssets.tenantId);
    return (await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.ownerType, ownerType),
          eq(mediaAssets.ownerId, ownerId),
          tenantCondition,
          isNull(mediaAssets.deletedAt),
        ),
      )) as MediaAssetRow[];
  }

  async findByS3Key(s3Key: string): Promise<MediaAssetRow | null> {
    const [row] = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.s3Key, s3Key), isNull(mediaAssets.deletedAt)))
      .limit(1);
    return (row as MediaAssetRow | undefined) ?? null;
  }

  /**
   * Find pending uploads older than `olderThan`. Used by the BE-24
   * cleanup job — pending uploads that never confirmed are orphans.
   */
  async findStalePending(olderThan: Date, limit = 100): Promise<MediaAssetRow[]> {
    return (await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.status, 'pending'),
          lt(mediaAssets.createdAt, olderThan),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .limit(limit)) as MediaAssetRow[];
  }

  async markStatus(id: string, status: MediaAssetRow['status']): Promise<MediaAssetRow> {
    const [row] = await this.db
      .update(mediaAssets)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(mediaAssets.id, id))
      .returning();
    return row as MediaAssetRow;
  }

  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db
      .delete(mediaAssets)
      .where(inArray(mediaAssets.id, ids))
      .returning({ id: mediaAssets.id });
    return (result as Array<{ id: string }>).length;
  }
}
