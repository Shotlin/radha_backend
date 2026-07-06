import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

/**
 * BE-13 — CDN URL builder.
 *
 * The Mobile_App and dashboards never see raw S3 URLs — every public
 * media URL is rendered through CloudFront. When `AWS_CLOUDFRONT_DOMAIN`
 * is empty (dev / mock setup) we fall back to the regional S3 URL so
 * the round-trip still works locally.
 *
 * Cache invalidation lives in BE-32 (it needs the AWS Lambda + IAM
 * wiring that BE-13 doesn't yet own).
 */
@Injectable()
export class CloudFrontService {
  private readonly logger = new Logger(CloudFrontService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Build a public URL for an S3 key.
   * @param s3Key — the canonical key as stored in `media_assets.s3_key`.
   */
  getCdnUrl(s3Key: string): string {
    const cleanKey = s3Key.replace(/^\/+/, '');
    const domain = this.config.aws.cloudfront.domain;
    if (!domain || domain.length === 0) {
      const bucket = this.config.aws.s3.bucket;
      const region = this.config.aws.s3.region;
      return `https://${bucket}.s3.${region}.amazonaws.com/${cleanKey}`;
    }
    return `https://${domain}/${cleanKey}`;
  }

  /**
   * Build a CDN URL for a specific image variant. The variant is
   * inserted before the file extension:
   *
   *   "tenant-1/product/abc.jpg" + "thumbnail"
   *     → "tenant-1/product/abc.thumbnail.jpg"
   *
   * BE-23 (image worker) must produce the variant object at exactly
   * this key for the URL to resolve.
   */
  getVariantUrl(s3Key: string, variant: 'thumbnail' | 'medium' | 'full'): string {
    if (variant === 'full') return this.getCdnUrl(s3Key);
    const lastDot = s3Key.lastIndexOf('.');
    const variantKey =
      lastDot === -1
        ? `${s3Key}.${variant}`
        : `${s3Key.slice(0, lastDot)}.${variant}${s3Key.slice(lastDot)}`;
    return this.getCdnUrl(variantKey);
  }

  /**
   * Cache invalidation (BE-32 owns the actual implementation). For
   * BE-13 this is a no-op log so the call site exists.
   */
  async invalidateCache(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    this.logger.log(`cloudfront.invalidate.requested count=${paths.length}`);
  }
}
