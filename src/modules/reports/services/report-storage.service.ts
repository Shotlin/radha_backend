import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { S3_SERVICE_TOKEN } from '@/integrations/aws/aws.module';
import type { IS3Service } from '@/integrations/aws/s3/s3.types';

/**
 * BE-21 — S3-backed report artefact storage.
 *
 * Thin adapter around the BE-13 `IS3Service` so the export pipeline
 * doesn't reach into AWS internals. Two responsibilities:
 *
 *   1. Upload a buffer + content-type to a key.
 *   2. Mint a presigned download URL (default 24 h, hard-capped at
 *      7 days by the controller).
 *
 * Lifecycle rules (90-day expiry) live on the bucket, not in this
 * service — that's an infra concern handled by the BE-49 IaC phase.
 *
 * The injected token resolves to either `S3Service` or
 * `MockS3Service` depending on whether AWS credentials are
 * configured (see `AwsModule`); both implement `IS3Service`.
 */
@Injectable()
export class ReportStorageService {
  constructor(
    @Inject(S3_SERVICE_TOKEN) private readonly s3: IS3Service,
    private readonly logger: LoggerService,
  ) {}

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    if (body.length === 0) {
      throw new Error('Refusing to upload an empty report buffer');
    }
    await this.s3.uploadObject(key, body, contentType);
    this.logger.info('reports.storage.uploaded', {
      s3Key: key,
      bytes: body.length,
      contentType,
    });
    return key;
  }

  async getDownloadUrl(key: string, expirySeconds: number): Promise<string> {
    return this.s3.generatePresignedDownloadUrl(key, expirySeconds);
  }

  async exists(key: string): Promise<boolean> {
    return this.s3.objectExists(key);
  }

  async delete(key: string): Promise<void> {
    await this.s3.deleteObject(key);
    this.logger.info('reports.storage.deleted', { s3Key: key });
  }
}
