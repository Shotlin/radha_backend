import { Inject, Injectable, Logger } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';
import { S3_SERVICE_TOKEN } from '@/integrations/aws/aws.module';
import type { IS3Service } from '@/integrations/aws/s3/s3.types';
import { AuditLogService } from '@/observability/audit-log.service';

import type { MediaAssetRow } from '@/db/schema/media-assets';

import { MediaRepository } from '../media.repository';
import type {
  ProcessedImageResult,
  ProcessedVariantName,
  ProcessedVariants,
  VariantInfo,
} from '../types/media.types';
import {
  computeOptimizationRatio,
  loadSharp,
  type SharpInstance,
  type SharpModule,
} from '../utils/image-optimization.utils';
import { ExifStripperService } from './exif-stripper.service';
import {
  ImageVariantsService,
  type VariantConfig,
  type VariantName,
} from './image-variants.service';

const VARIANT_WEBP_CONTENT_TYPE = 'image/webp';

/**
 * BE-23 — Async image processor.
 *
 *   1. HEAD media row, transition `uploaded → processing`.
 *   2. Download original from S3.
 *   3. Strip EXIF + auto-orient (privacy + correctness).
 *   4. Generate four WebP variants in parallel from the stripped
 *      buffer. Aspect ratio preserved (`fit: 'inside'`), no
 *      enlargement.
 *   5. Upload each variant under the `_<variant>.webp` suffix.
 *   6. Persist the variant manifest + width/height + processedAt onto
 *      the media row, transition `processing → ready`.
 *   7. On any failure: mark `failed` and re-throw.
 *
 * Concurrency / load:
 *   - This service is invoked by `ImageProcessingQueueService` (sync
 *     v1 inside the request, BE-24 swaps in BullMQ).
 *   - Sharp uses libvips threads internally. We don't add a Promise
 *     pool; the worker process can saturate at the libvips level.
 *
 * Failure isolation:
 *   - If `sharp` is not installed, the call throws a typed
 *     `BusinessException` so the operator sees the diagnostic in the
 *     API envelope. The media row stays `uploaded` (not `failed`)
 *     because the bytes are still valid; reprocessing once Sharp is
 *     installed will succeed.
 */
@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);

  constructor(
    @Inject(S3_SERVICE_TOKEN) private readonly s3: IS3Service,
    private readonly cdn: CloudFrontService,
    private readonly mediaRepo: MediaRepository,
    private readonly variants: ImageVariantsService,
    private readonly exif: ExifStripperService,
    private readonly audit: AuditLogService,
  ) {}

  async processImage(mediaId: string): Promise<ProcessedImageResult> {
    const startTime = Date.now();
    const media = await this.mediaRepo.findById(mediaId);
    if (!media) throw new DomainNotFoundException('media_assets', mediaId);

    if (media.status === 'deleted') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot process deleted media: ${mediaId}`,
      );
    }
    if (media.status === 'pending') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot process media in pending state — confirm upload first: ${mediaId}`,
      );
    }

    const sharp = await loadSharp();
    if (!sharp) {
      throw new BusinessException(
        ErrorCode.INTERNAL_SERVER_ERROR,
        'sharp is not installed — image processing unavailable',
      );
    }

    await this.mediaRepo.markStatus(media.id, 'processing');

    try {
      const original = await this.s3.downloadObject(media.s3Key);
      const stripped = await this.exif.strip(original);

      const originalMeta = await sharp(stripped).metadata();
      const variantInfos = await this.generateAndUploadVariants(sharp, stripped, media.s3Key);

      const originalInfo: VariantInfo = {
        s3Key: media.s3Key,
        cdnUrl: this.cdn.getCdnUrl(media.s3Key),
        width: originalMeta.width ?? media.width ?? 0,
        height: originalMeta.height ?? media.height ?? 0,
        sizeBytes: media.contentLength,
        format: originalMeta.format ?? 'unknown',
      };

      const fullVariants: ProcessedVariants = {
        ...variantInfos,
        original: originalInfo,
      };

      const processedTotal = Object.values(variantInfos).reduce((acc, v) => acc + v.sizeBytes, 0);
      const totalSizeBytes = processedTotal + media.contentLength;
      const optimizationRatio = computeOptimizationRatio(media.contentLength, processedTotal);

      await this.mediaRepo.update(media.id, {
        status: 'ready',
        width: originalInfo.width,
        height: originalInfo.height,
        variants: this.serialiseVariants(fullVariants),
        processedAt: new Date(),
      });

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `image.processed mediaId=${media.id} variants=${Object.keys(variantInfos).length} bytes=${processedTotal} ratio=${optimizationRatio} ms=${durationMs}`,
      );

      // Audit: every state-changing write to a media row gets a
      // structured audit entry. Tenant id may be null for global /
      // OFF-migrated rows; AuditLogService handles the fallback.
      await this.audit
        .logAction({
          action: 'UPDATE',
          resourceType: 'media_assets',
          resourceId: media.id,
          userId: media.uploadedBy ?? 'system',
          tenantId: media.tenantId ?? 'system',
          success: true,
          metadata: {
            event: 'image.processed',
            variants: Object.keys(variantInfos).length,
            originalBytes: media.contentLength,
            processedBytes: processedTotal,
            optimizationRatio,
            durationMs,
          },
        })
        .catch((err) =>
          this.logger.warn(
            `image.process.audit.failed mediaId=${media.id} err=${(err as Error).message}`,
          ),
        );

      return {
        mediaId: media.id,
        variants: fullVariants,
        totalSizeBytes,
        optimizationRatio,
        durationMs,
      };
    } catch (err) {
      await this.mediaRepo.markStatus(media.id, 'failed').catch((markErr) => {
        this.logger.error(
          `image.process.markFailed.failed mediaId=${media.id} err=${(markErr as Error).message}`,
        );
      });
      this.logger.error(`image.process.failed mediaId=${media.id} err=${(err as Error).message}`);
      await this.audit
        .logAction({
          action: 'UPDATE',
          resourceType: 'media_assets',
          resourceId: media.id,
          userId: media.uploadedBy ?? 'system',
          tenantId: media.tenantId ?? 'system',
          success: false,
          errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
          metadata: {
            event: 'image.process.failed',
            error: (err as Error).message,
          },
        })
        .catch(() => undefined);
      throw err;
    }
  }

  /** Public for the variants endpoint — read the manifest off the row. */
  buildVariantManifest(media: MediaAssetRow): ProcessedVariants | null {
    const stored = (media.variants ?? null) as Record<string, unknown> | null;
    if (!stored || Object.keys(stored).length === 0) return null;
    const out: Partial<ProcessedVariants> = {};
    for (const name of [
      'thumbnail',
      'small',
      'medium',
      'large',
      'original',
    ] as ProcessedVariantName[]) {
      const candidate = stored[name];
      if (candidate && typeof candidate === 'object') {
        const v = candidate as Record<string, unknown>;
        if (
          typeof v.s3Key === 'string' &&
          typeof v.cdnUrl === 'string' &&
          typeof v.width === 'number' &&
          typeof v.height === 'number' &&
          typeof v.sizeBytes === 'number' &&
          typeof v.format === 'string'
        ) {
          out[name] = {
            s3Key: v.s3Key,
            cdnUrl: v.cdnUrl,
            width: v.width,
            height: v.height,
            sizeBytes: v.sizeBytes,
            format: v.format,
          };
        }
      }
    }
    if (!out.thumbnail || !out.small || !out.medium || !out.large || !out.original) {
      return null;
    }
    return out as ProcessedVariants;
  }

  /* ───────────────── private helpers ───────────────── */

  private async generateAndUploadVariants(
    sharp: SharpModule,
    buffer: Buffer,
    originalKey: string,
  ): Promise<Record<VariantName, VariantInfo>> {
    const tasks = this.variants.list().map(async (cfg) => {
      const result = await this.renderVariant(sharp, buffer, cfg);
      const variantKey = this.variants.buildVariantKey(originalKey, cfg.name);
      await this.s3.uploadObject(variantKey, result.buffer, VARIANT_WEBP_CONTENT_TYPE);
      const info: VariantInfo = {
        s3Key: variantKey,
        cdnUrl: this.cdn.getCdnUrl(variantKey),
        width: result.width,
        height: result.height,
        sizeBytes: result.buffer.length,
        format: 'webp',
      };
      return { name: cfg.name, info };
    });
    const settled = await Promise.all(tasks);
    return settled.reduce(
      (acc, entry) => {
        acc[entry.name] = entry.info;
        return acc;
      },
      {} as Record<VariantName, VariantInfo>,
    );
  }

  private async renderVariant(
    sharp: SharpModule,
    buffer: Buffer,
    cfg: VariantConfig,
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const pipeline: SharpInstance = sharp(buffer)
      .resize({
        width: cfg.width,
        height: cfg.height,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: cfg.quality, effort: cfg.effort });
    const out = await pipeline.toBuffer();
    const meta = await sharp(out).metadata();
    return {
      buffer: out,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    };
  }

  /**
   * Convert the typed manifest back to the loose JSON shape stored
   * in `media_assets.variants`. The schema column is `jsonb` typed
   * as `Record<string, string>` — we widen to `unknown` here because
   * each variant carries an object, not a single string.
   */
  private serialiseVariants(variants: ProcessedVariants): Record<string, string> {
    const out: Record<string, unknown> = {};
    for (const [name, info] of Object.entries(variants)) {
      out[name] = info;
    }
    return out as unknown as Record<string, string>;
  }
}
