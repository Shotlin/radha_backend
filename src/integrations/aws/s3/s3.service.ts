import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { ExternalServiceException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import type {
  IS3Service,
  ObjectMetadata,
  PresignUploadParams,
  PresignedUploadResult,
} from './s3.types';

type S3ClientModule = typeof import('@aws-sdk/client-s3');
type S3PresignedPostModule = typeof import('@aws-sdk/s3-presigned-post');
type S3PresignerModule = typeof import('@aws-sdk/s3-request-presigner');

interface LoadedSdk {
  client: S3ClientModule;
  presignedPost: S3PresignedPostModule;
  presigner: S3PresignerModule;
}

/**
 * BE-13 — Real S3 wrapper backed by `@aws-sdk/client-s3`.
 *
 * The SDK is **dynamically imported** the first time a method is
 * called, so we don't pay for the AWS SDK boot cost when:
 *   - the dev environment uses MockS3Service,
 *   - tests run without network access,
 *   - the worker process starts without media handling work.
 *
 * Errors are translated into `ExternalServiceException(S3_*)` so the
 * standard error envelope (BE-04) renders with a stable code the
 * Mobile_App can switch on.
 */
@Injectable()
export class S3Service implements IS3Service, OnModuleDestroy {
  private readonly logger = new Logger(S3Service.name);
  private sdk: LoadedSdk | null = null;
  private clientInstance: InstanceType<S3ClientModule['S3Client']> | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    if (
      this.clientInstance &&
      typeof (this.clientInstance as { destroy?: () => void }).destroy === 'function'
    ) {
      try {
        (this.clientInstance as { destroy: () => void }).destroy();
      } catch (err) {
        this.logger.warn(`s3.client.destroy failed: ${(err as Error).message}`);
      }
    }
    this.clientInstance = null;
    this.sdk = null;
  }

  async generatePresignedUploadUrl(params: PresignUploadParams): Promise<PresignedUploadResult> {
    const { sdk, client } = await this.ensureClient();
    const expirySeconds = params.expirySeconds ?? this.config.aws.s3.presignedUrlExpirySeconds;
    try {
      const presigned = await sdk.presignedPost.createPresignedPost(client, {
        Bucket: this.config.aws.s3.bucket,
        Key: params.key,
        Conditions: [
          ['content-length-range', 1, params.contentLength],
          ['eq', '$Content-Type', params.contentType],
        ],
        Fields: {
          'Content-Type': params.contentType,
          ...params.metadata,
        },
        Expires: expirySeconds,
      });
      return {
        url: presigned.url,
        fields: presigned.fields,
        expiresIn: expirySeconds,
        uploadKey: params.key,
      };
    } catch (err) {
      throw new ExternalServiceException('S3', err as Error, ErrorCode.S3_UPLOAD_FAILED);
    }
  }

  async generatePresignedDownloadUrl(key: string, expirySeconds = 86_400): Promise<string> {
    const { sdk, client } = await this.ensureClient();
    try {
      const command = new sdk.client.GetObjectCommand({
        Bucket: this.config.aws.s3.bucket,
        Key: key,
      });
      return await sdk.presigner.getSignedUrl(client, command, { expiresIn: expirySeconds });
    } catch (err) {
      throw new ExternalServiceException('S3', err as Error, ErrorCode.S3_DOWNLOAD_FAILED);
    }
  }

  async uploadObject(key: string, body: Buffer, contentType: string): Promise<string> {
    const { sdk, client } = await this.ensureClient();
    try {
      await client.send(
        new sdk.client.PutObjectCommand({
          Bucket: this.config.aws.s3.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return key;
    } catch (err) {
      throw new ExternalServiceException('S3', err as Error, ErrorCode.S3_UPLOAD_FAILED);
    }
  }

  async downloadObject(key: string): Promise<Buffer> {
    const { sdk, client } = await this.ensureClient();
    try {
      const response = await client.send(
        new sdk.client.GetObjectCommand({
          Bucket: this.config.aws.s3.bucket,
          Key: key,
        }),
      );
      if (!response.Body) throw new Error('Empty response body');
      const chunks: Buffer[] = [];
      const stream = response.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (err) {
      throw new ExternalServiceException('S3', err as Error, ErrorCode.S3_DOWNLOAD_FAILED);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const { sdk, client } = await this.ensureClient();
    try {
      await client.send(
        new sdk.client.DeleteObjectCommand({
          Bucket: this.config.aws.s3.bucket,
          Key: key,
        }),
      );
    } catch (err) {
      throw new ExternalServiceException('S3', err as Error);
    }
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const { sdk, client } = await this.ensureClient();
    try {
      await client.send(
        new sdk.client.CopyObjectCommand({
          Bucket: this.config.aws.s3.bucket,
          Key: destKey,
          CopySource: `${this.config.aws.s3.bucket}/${encodeURIComponent(sourceKey)}`,
        }),
      );
    } catch (err) {
      throw new ExternalServiceException('S3', err as Error);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    const { sdk, client } = await this.ensureClient();
    try {
      await client.send(
        new sdk.client.HeadObjectCommand({
          Bucket: this.config.aws.s3.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (err) {
      const name = (err as { name?: string; $metadata?: { httpStatusCode?: number } }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === 'NotFound' || status === 404) return false;
      throw new ExternalServiceException('S3', err as Error);
    }
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata> {
    const { sdk, client } = await this.ensureClient();
    try {
      const response = await client.send(
        new sdk.client.HeadObjectCommand({
          Bucket: this.config.aws.s3.bucket,
          Key: key,
        }),
      );
      return {
        contentType: response.ContentType ?? 'application/octet-stream',
        contentLength: response.ContentLength ?? 0,
        lastModified: response.LastModified,
      };
    } catch (err) {
      throw new ExternalServiceException('S3', err as Error);
    }
  }

  private async ensureClient(): Promise<{
    sdk: LoadedSdk;
    client: InstanceType<S3ClientModule['S3Client']>;
  }> {
    if (this.sdk && this.clientInstance) {
      return { sdk: this.sdk, client: this.clientInstance };
    }
    const [client, presignedPost, presigner] = await Promise.all([
      import('@aws-sdk/client-s3').catch(() => null),
      import('@aws-sdk/s3-presigned-post').catch(() => null),
      import('@aws-sdk/s3-request-presigner').catch(() => null),
    ]);
    if (!client || !presignedPost || !presigner) {
      throw new ExternalServiceException(
        'S3',
        new Error('@aws-sdk packages are not installed'),
        ErrorCode.S3_UPLOAD_FAILED,
      );
    }
    this.sdk = {
      client: client as S3ClientModule,
      presignedPost: presignedPost as S3PresignedPostModule,
      presigner: presigner as S3PresignerModule,
    };
    this.clientInstance = new this.sdk.client.S3Client({
      region: this.config.aws.s3.region,
      credentials: {
        accessKeyId: this.config.aws.accessKeyId,
        secretAccessKey: this.config.aws.secretAccessKey,
      },
    });
    return { sdk: this.sdk, client: this.clientInstance };
  }
}
