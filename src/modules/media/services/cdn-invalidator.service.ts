import { Injectable, Logger } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import { CloudFrontClientService } from '@/integrations/aws/cloudfront/cloudfront-client.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { MediaRepository } from '../media.repository';
import type { InvalidationResult, ProcessedVariants } from '../types/media.types';

/**
 * BE-23 — CloudFront cache invalidation orchestrator.
 *
 *   - `invalidate(paths)`         — raw passthrough.
 *   - `invalidateByMediaId(id)`   — looks up the media row, gathers
 *                                   the canonical s3Key + every
 *                                   variant key, normalises to leading
 *                                   slashes, fires a single batch.
 *   - `invalidateAll()`           — wildcard `/*`. Use only on
 *                                   migration / disaster recovery.
 *
 * The implementation delegates the AWS API call to
 * `CloudFrontClientService` so the SDK loading + skip-when-not-configured
 * behaviour lives in one place.
 */
@Injectable()
export class CdnInvalidatorService {
  private readonly logger = new Logger(CdnInvalidatorService.name);

  constructor(
    private readonly client: CloudFrontClientService,
    private readonly mediaRepo: MediaRepository,
    private readonly audit: AuditLogService,
  ) {}

  async invalidate(paths: string[]): Promise<InvalidationResult> {
    const normalised = this.normalise(paths);
    if (normalised.length === 0) {
      return { invalidationId: 'noop', paths: [], status: 'completed' };
    }
    const result = await this.client.createInvalidation(normalised);
    return {
      invalidationId: result.invalidationId,
      paths: result.paths,
      status: result.status,
    };
  }

  async invalidateByMediaId(mediaId: string): Promise<InvalidationResult> {
    const media = await this.mediaRepo.findById(mediaId);
    if (!media) throw new DomainNotFoundException('media_assets', mediaId);

    const paths = new Set<string>();
    paths.add(media.s3Key);

    const variants = (media.variants ?? null) as ProcessedVariants | null;
    if (variants) {
      for (const v of Object.values(variants)) {
        if (v && typeof v === 'object' && typeof (v as { s3Key?: string }).s3Key === 'string') {
          paths.add((v as { s3Key: string }).s3Key);
        }
      }
    }

    const result = await this.invalidate(Array.from(paths));

    // Audit: CDN cache purges affect downstream user-visible state.
    // Tenant-scoped because cache invalidation cost is plan-relevant.
    await this.audit
      .logAction({
        action: 'UPDATE',
        resourceType: 'media_assets',
        resourceId: media.id,
        userId: media.uploadedBy ?? 'system',
        tenantId: media.tenantId ?? 'system',
        success: result.status !== 'skipped',
        metadata: {
          event: 'cdn.invalidate.media',
          paths: result.paths.length,
          invalidationId: result.invalidationId,
          status: result.status,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `cdn.invalidate.audit.failed mediaId=${mediaId} err=${(err as Error).message}`,
        ),
      );

    return result;
  }

  /**
   * Nuke the entire distribution cache. Used by the dashboard's
   * "Force CDN refresh" admin button. Charged per invalidation —
   * AWS gives 1000 free paths/month, so a single `/*` is the cheapest
   * way to do a global purge.
   */
  async invalidateAll(): Promise<InvalidationResult> {
    this.logger.warn('cloudfront.invalidate.all wildcard requested');
    return this.invalidate(['/*']);
  }

  /**
   * Ensures every path begins with `/` and de-dupes. CloudFront
   * rejects entries longer than 4000 bytes — we don't enforce here
   * because the variant key layout caps key length around 200 chars.
   */
  private normalise(paths: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
      if (typeof p !== 'string' || p.length === 0) continue;
      const normalised = p.startsWith('/') ? p : `/${p}`;
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      out.push(normalised);
    }
    return out;
  }
}
