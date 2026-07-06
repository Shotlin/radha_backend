import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';
import { S3_SERVICE_TOKEN } from '@/integrations/aws/aws.module';
import type { IS3Service } from '@/integrations/aws/s3/s3.types';
import { LoggerService } from '@/logging/logger.service';
import { ProductsRepository } from '@/modules/products/products.repository';

/** One curated pack-shot to host: a resolved EAN + the local image file. */
export interface CuratedImageInput {
  /** Curated product slug (asset stem + manifest key). */
  slug: string;
  /** The real EAN resolved by the curated seed — the global catalog row key. */
  ean: string;
  /** Absolute path to the local pack-shot (e.g. the bundled WebP). */
  filePath: string;
}

export interface CatalogImageHostItemResult {
  slug: string;
  ean: string;
  status: 'hosted' | 'skipped_exists' | 'no_catalog_row' | 'error';
  cdnUrl?: string;
}

export interface CatalogImageHostSummary {
  uploaded: number;
  alreadyPresent: number;
  catalogRowsUpdated: number;
  missingCatalogRows: number;
  errors: number;
  items: CatalogImageHostItemResult[];
}

/**
 * Phase 3 — hosts curated product pack-shots on S3 + CloudFront and points the
 * seeded global catalog rows at the CDN URL.
 *
 * Honesty + safety:
 *   - Only acts on EANs that already exist as global catalog rows (the curated
 *     seed must run first). A missing row is reported, never invented.
 *   - Idempotent: skips the S3 upload when the object already exists, and the
 *     `image_url` update is a plain overwrite — safe to re-run.
 *   - All S3/CloudFront access goes through the AWS integration layer (the
 *     `S3_SERVICE_TOKEN` resolves to the mock when no AWS creds are set, so this
 *     is harmless in dev/CI).
 *
 * Object key layout: `catalog/products/<ean>.webp` — stable, deterministic, and
 * independent of tenant (these are global catalog images).
 */
@Injectable()
export class CatalogImageHostService {
  constructor(
    @Inject(S3_SERVICE_TOKEN) private readonly s3: IS3Service,
    private readonly cdn: CloudFrontService,
    private readonly products: ProductsRepository,
    private readonly logger: LoggerService,
  ) {}

  /** S3 key for a curated product image, keyed by its real EAN. */
  static keyForEan(ean: string, ext = 'webp'): string {
    return `catalog/products/${ean}.${ext}`;
  }

  async hostAll(inputs: readonly CuratedImageInput[]): Promise<CatalogImageHostSummary> {
    const summary: CatalogImageHostSummary = {
      uploaded: 0,
      alreadyPresent: 0,
      catalogRowsUpdated: 0,
      missingCatalogRows: 0,
      errors: 0,
      items: [],
    };

    for (const input of inputs) {
      try {
        await this.hostOne(input, summary);
      } catch (err) {
        summary.errors += 1;
        summary.items.push({ slug: input.slug, ean: input.ean, status: 'error' });
        this.logger.warn('catalog.image_host.failed', {
          slug: input.slug,
          ean: input.ean,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }

    this.logger.info('catalog.image_host.complete', {
      uploaded: summary.uploaded,
      alreadyPresent: summary.alreadyPresent,
      catalogRowsUpdated: summary.catalogRowsUpdated,
      missingCatalogRows: summary.missingCatalogRows,
      errors: summary.errors,
    });
    return summary;
  }

  private async hostOne(input: CuratedImageInput, summary: CatalogImageHostSummary): Promise<void> {
    const ext = this.extOf(input.filePath);
    const key = CatalogImageHostService.keyForEan(input.ean, ext);

    // Idempotent upload — skip the transfer if the object is already hosted.
    const exists = await this.s3.objectExists(key);
    if (exists) {
      summary.alreadyPresent += 1;
    } else {
      const body = await readFile(input.filePath);
      await this.s3.uploadObject(key, body, this.contentTypeOf(ext));
      summary.uploaded += 1;
    }

    const cdnUrl = this.cdn.getCdnUrl(key);

    // Point the seeded global catalog row at the CDN URL (only if it exists).
    const updated = await this.products.updateGlobalImageByEan(input.ean, cdnUrl);
    if (updated) {
      summary.catalogRowsUpdated += 1;
      summary.items.push({
        slug: input.slug,
        ean: input.ean,
        status: exists ? 'skipped_exists' : 'hosted',
        cdnUrl,
      });
    } else {
      summary.missingCatalogRows += 1;
      summary.items.push({ slug: input.slug, ean: input.ean, status: 'no_catalog_row', cdnUrl });
      this.logger.info('catalog.image_host.no_catalog_row', {
        slug: input.slug,
        ean: input.ean,
      });
    }
  }

  private extOf(filePath: string): string {
    const name = basename(filePath);
    const dot = name.lastIndexOf('.');
    return dot === -1 ? 'webp' : name.slice(dot + 1).toLowerCase();
  }

  private contentTypeOf(ext: string): string {
    switch (ext) {
      case 'webp':
        return 'image/webp';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      default:
        return 'application/octet-stream';
    }
  }
}
