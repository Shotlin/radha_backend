import { Inject, Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainNotFoundException,
  ValidationException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';
import { S3_SERVICE_TOKEN } from '@/integrations/aws/aws.module';
import type { IS3Service } from '@/integrations/aws/s3/s3.types';

import type { MediaAssetRow } from '@/db/schema/media-assets';

import { ConfirmUploadDto, MigrateFromUrlDto, PresignUploadDto } from './dto/media.dto';
import { MediaRepository } from './media.repository';
import { ImageProcessorService } from './services/image-processor.service';
import { ImageValidatorService } from './services/image-validator.service';
import type {
  ImageVariant,
  MediaAssetView,
  MediaVariants,
  UploadInitResult,
  VariantListView,
} from './types/media.types';
import { buildS3Key, buildVariantKey } from './utils/file-key.utils';

const URL_MIGRATION_TIMEOUT_MS = 10_000;

/**
 * BE-13 — Media orchestrator.
 *
 * Owns the full upload lifecycle:
 *   1. `initiateUpload`  — validates inputs, reserves a media row in
 *      `pending`, hands back a presigned POST URL.
 *   2. `confirmUpload`   — HEADs S3, confirms bytes, transitions
 *      pending → uploaded → ready (BE-23 will insert a
 *      `processing → ready` step once variants exist).
 *   3. `migrateFromUrl`  — downloads an external image (e.g. OFF),
 *      validates the bytes, uploads to our bucket, persists.
 *
 * Tenant scoping: rows always carry the requester's tenant unless the
 * owner is the global product catalog (`ownerType: 'product'` and
 * `ownerId` resolves to a `tenant_id IS NULL` product) — see
 * `migrateFromUrl` which writes `tenantId: null` for OFF migrations.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    @Inject(S3_SERVICE_TOKEN) private readonly s3: IS3Service,
    private readonly cdn: CloudFrontService,
    private readonly mediaRepo: MediaRepository,
    private readonly validator: ImageValidatorService,
    private readonly processor: ImageProcessorService,
  ) {}

  /* ─────────────────── Upload flow ─────────────────── */

  async initiateUpload(
    dto: PresignUploadDto,
    userId: string,
    tenantId: string | null,
  ): Promise<UploadInitResult> {
    this.validator.validateContentType(dto.contentType);
    this.validator.validateSize(dto.contentLength);

    const { key, mediaId } = buildS3Key({
      tenantId,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId ?? null,
      contentType: dto.contentType,
    });

    await this.mediaRepo.create({
      id: mediaId,
      tenantId,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId ?? null,
      s3Bucket: this.config.aws.s3.bucket,
      s3Key: key,
      contentType: dto.contentType,
      contentLength: dto.contentLength,
      status: 'pending',
      uploadedBy: userId,
      metadata: dto.filename ? { filename: dto.filename } : {},
    });

    const presigned = await this.s3.generatePresignedUploadUrl({
      key,
      contentType: dto.contentType,
      contentLength: dto.contentLength,
      expirySeconds: this.config.aws.s3.presignedUrlExpirySeconds,
      metadata: {
        'x-amz-meta-media-id': mediaId,
        'x-amz-meta-tenant-id': tenantId ?? 'global',
        'x-amz-meta-owner-type': dto.ownerType,
      },
    });

    return {
      mediaId,
      uploadUrl: presigned.url,
      uploadFields: presigned.fields,
      expiresIn: presigned.expiresIn,
      cdnUrl: this.cdn.getCdnUrl(key),
      s3Key: key,
    };
  }

  async confirmUpload(dto: ConfirmUploadDto, tenantId: string | null): Promise<MediaAssetView> {
    const media = await this.mediaRepo.findVisibleById(dto.mediaId, tenantId);
    if (!media) throw new DomainNotFoundException('media_assets', dto.mediaId);

    if (media.status === 'ready' || media.status === 'uploaded') {
      // Idempotent — already confirmed.
      return this.toView(media);
    }
    if (media.status !== 'pending') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot confirm upload in status ${media.status}`,
      );
    }

    const exists = await this.s3.objectExists(media.s3Key);
    if (!exists) {
      await this.mediaRepo.markStatus(media.id, 'failed');
      throw new ValidationException('Upload not found in S3', {
        field: 'mediaId',
        value: dto.mediaId,
      });
    }

    const meta = await this.s3.getObjectMetadata(media.s3Key);
    if (meta.contentType.toLowerCase() !== media.contentType.toLowerCase()) {
      await this.mediaRepo.markStatus(media.id, 'failed');
      throw new ValidationException('Uploaded content-type does not match declared type', {
        field: 'contentType',
        value: meta.contentType,
        expected: media.contentType,
      });
    }

    const updated = await this.mediaRepo.update(media.id, {
      status: 'ready',
      uploadedAt: new Date(),
      processedAt: new Date(),
      contentLength: meta.contentLength,
    });

    // BE-23 — fire-and-forget image processing. The row is already
    // 'ready' so callers can serve the original immediately; once the
    // processor completes, the row gets updated with width/height and
    // the variants manifest, which the variant endpoint then surfaces.
    // Failures are logged + persisted on the row; we never reject the
    // user's confirmation because the variants couldn't be generated.
    void this.processor.processImage(updated.id).catch((err) => {
      this.logger.warn('media.confirm.processing_failed', {
        mediaId: updated.id,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    });

    return this.toView(updated);
  }

  /* ─────────────────── Read / delete ─────────────────── */

  async getById(id: string, tenantId: string | null): Promise<MediaAssetView> {
    const media = await this.mediaRepo.findVisibleById(id, tenantId);
    if (!media) throw new DomainNotFoundException('media_assets', id);
    return this.toView(media);
  }

  async listByOwner(
    ownerType: MediaAssetRow['ownerType'],
    ownerId: string,
    tenantId: string | null,
  ): Promise<MediaAssetView[]> {
    const rows = await this.mediaRepo.findByOwner(ownerType, ownerId, tenantId);
    return rows.map((r) => this.toView(r));
  }

  async delete(id: string, userId: string, tenantId: string | null): Promise<void> {
    const media = await this.mediaRepo.findVisibleById(id, tenantId);
    if (!media) throw new DomainNotFoundException('media_assets', id);

    await this.mediaRepo.softDelete(id, userId);
    // Delete S3 object — tolerate failures here so the DB stays consistent.
    try {
      await this.s3.deleteObject(media.s3Key);
      // Also clean up any known variants. BE-23 owns variant creation
      // but we still try to delete them by name on the assumption they
      // follow the documented `<key>.<variant>.<ext>` layout.
      for (const variant of ['thumbnail', 'medium'] as const) {
        const variantKey = buildVariantKey(media.s3Key, variant);
        if (variantKey !== media.s3Key) {
          await this.s3.deleteObject(variantKey).catch(() => undefined);
        }
      }
    } catch (err) {
      this.logger.warn('media.delete.s3_cleanup_failed', {
        mediaId: id,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    }
  }

  /* ─────────────────── External URL migration ─────────────────── */

  async migrateFromUrl(
    dto: MigrateFromUrlDto,
    userId: string,
    tenantId: string | null,
  ): Promise<MediaAssetView> {
    // Existing migration for the same product+source-url is idempotent.
    const existing = (await this.mediaRepo.findByOwner('product', dto.productId, tenantId)).find(
      (m) => m.sourceUrl === dto.url,
    );
    if (existing) return this.toView(existing);

    const buffer = await this.fetchUrl(dto.url);
    const declaredContentType = this.contentTypeFromBuffer(buffer) ?? 'image/jpeg';
    this.validator.validateContentType(declaredContentType);
    this.validator.validateSize(buffer.length);
    this.validator.validateImageBuffer(buffer, declaredContentType);

    const { key, mediaId } = buildS3Key({
      tenantId,
      ownerType: 'product',
      ownerId: dto.productId,
      contentType: declaredContentType,
    });

    await this.s3.uploadObject(key, buffer, declaredContentType);

    const row = await this.mediaRepo.create({
      id: mediaId,
      tenantId,
      ownerType: 'product',
      ownerId: dto.productId,
      s3Bucket: this.config.aws.s3.bucket,
      s3Key: key,
      contentType: declaredContentType,
      contentLength: buffer.length,
      status: 'ready',
      uploadedAt: new Date(),
      processedAt: new Date(),
      uploadedBy: userId,
      sourceUrl: dto.url,
    });
    return this.toView(row);
  }

  /* ─────────────────── Variants ─────────────────── */

  buildVariants(media: MediaAssetRow): MediaVariants {
    return {
      thumbnail: this.cdn.getVariantUrl(media.s3Key, 'thumbnail'),
      medium: this.cdn.getVariantUrl(media.s3Key, 'medium'),
      full: this.cdn.getVariantUrl(media.s3Key, 'full'),
    };
  }

  getCdnUrl(s3Key: string, variant: ImageVariant = 'full'): string {
    return this.cdn.getVariantUrl(s3Key, variant);
  }

  /**
   * BE-23 — read the variant manifest from the media row. Returns
   * `null` for `variants` when processing hasn't completed yet so
   * callers can fall back to the parent `cdnUrl`.
   */
  async getVariantManifest(id: string, tenantId: string | null): Promise<VariantListView> {
    const media = await this.mediaRepo.findVisibleById(id, tenantId);
    if (!media) throw new DomainNotFoundException('media_assets', id);
    return {
      mediaId: media.id,
      status: media.status,
      variants: this.processor.buildVariantManifest(media),
      width: media.width,
      height: media.height,
      processedAt: media.processedAt,
    };
  }

  /* ─────────────────── Helpers ─────────────────── */

  private toView(row: MediaAssetRow): MediaAssetView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      status: row.status,
      contentType: row.contentType,
      contentLength: row.contentLength,
      s3Key: row.s3Key,
      cdnUrl: this.cdn.getCdnUrl(row.s3Key),
      variants: this.buildVariants(row),
      uploadedAt: row.uploadedAt,
      processedAt: row.processedAt,
      width: row.width,
      height: row.height,
    };
  }

  private async fetchUrl(url: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_MIGRATION_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'RADHA/1.0 (image migration)' },
      });
      if (!response.ok) {
        throw new ValidationException(`Source URL responded with ${response.status}`, {
          field: 'url',
          value: url,
        });
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      if (err instanceof ValidationException) throw err;
      throw new BusinessException(
        ErrorCode.EXTERNAL_SERVICE_ERROR,
        `Failed to fetch source URL: ${(err as Error).message}`,
        { metadata: { url } },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private contentTypeFromBuffer(buffer: Buffer): string | null {
    const meta = this.validator.detectFormat(buffer);
    if (!meta.recognised) return null;
    return `image/${meta.format}`;
  }
}
