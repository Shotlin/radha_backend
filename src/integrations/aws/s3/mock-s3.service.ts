import { Injectable, Logger } from '@nestjs/common';

import type {
  IS3Service,
  ObjectMetadata,
  PresignUploadParams,
  PresignedUploadResult,
} from './s3.types';

/**
 * BE-13 — In-memory S3 stand-in.
 *
 * Used in:
 *   - unit tests (no AWS access),
 *   - dev without `AWS_ACCESS_KEY_ID` (so `pnpm start:dev` doesn't 500
 *     on every media call).
 *
 * Generates a "presigned URL" pointing back at our own dev host so
 * the Mobile_App can complete the round-trip locally. The base
 * defaults to `http://localhost:3000` (correct when a browser/curl on
 * the same machine round-trips), but is overridable via
 * `MOCK_S3_PUBLIC_BASE_URL` — needed when the caller is an Android
 * emulator, where `localhost` resolves to the emulator itself, not
 * the host running this server (use `http://10.0.2.2:3000` there).
 * Production never hits this path because `S3Service` is selected in
 * real environments.
 */
@Injectable()
export class MockS3Service implements IS3Service {
  private readonly logger = new Logger(MockS3Service.name);
  private readonly baseUrl = (
    process.env.MOCK_S3_PUBLIC_BASE_URL ?? 'http://localhost:3000'
  ).replace(/\/+$/, '');
  private readonly objects = new Map<
    string,
    { body: Buffer; contentType: string; uploadedAt: Date }
  >();

  async generatePresignedUploadUrl(params: PresignUploadParams): Promise<PresignedUploadResult> {
    const expirySeconds = params.expirySeconds ?? 600;
    this.logger.debug(`mock-s3.presign ${params.key}`);
    return {
      url: `${this.baseUrl}/api/_mock-s3/upload/${encodeURIComponent(params.key)}`,
      fields: {
        'Content-Type': params.contentType,
        ...params.metadata,
      },
      expiresIn: expirySeconds,
      uploadKey: params.key,
    };
  }

  async generatePresignedDownloadUrl(key: string, expirySeconds = 86400): Promise<string> {
    return `${this.baseUrl}/api/_mock-s3/download/${encodeURIComponent(key)}?expires=${expirySeconds}`;
  }

  async uploadObject(key: string, body: Buffer, contentType: string): Promise<string> {
    this.objects.set(key, { body, contentType, uploadedAt: new Date() });
    return key;
  }

  async downloadObject(key: string): Promise<Buffer> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`Mock S3: object not found at ${key}`);
    return obj.body;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const obj = this.objects.get(sourceKey);
    if (!obj) throw new Error(`Mock S3: source not found at ${sourceKey}`);
    this.objects.set(destKey, { ...obj, uploadedAt: new Date() });
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`Mock S3: object not found at ${key}`);
    return {
      contentType: obj.contentType,
      contentLength: obj.body.length,
      lastModified: obj.uploadedAt,
    };
  }

  /** Test helper — seed an object directly. */
  __seed(key: string, body: Buffer, contentType: string): void {
    this.objects.set(key, { body, contentType, uploadedAt: new Date() });
  }

  /** Test helper — clear all stored objects. */
  __reset(): void {
    this.objects.clear();
  }
}
