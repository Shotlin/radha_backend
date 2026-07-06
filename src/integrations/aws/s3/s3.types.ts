/**
 * BE-13 — S3 service contract.
 *
 * Two implementations:
 *   - `S3Service`            — real `@aws-sdk/client-s3` calls.
 *   - `MockS3Service`        — in-memory map keyed by `s3Key`. Used in
 *                              tests and when AWS credentials aren't
 *                              configured (dev with `AWS_ACCESS_KEY_ID=""`).
 *
 * The selector lives in `S3Module.forRoot()`.
 */

export interface PresignUploadParams {
  key: string;
  contentType: string;
  contentLength: number;
  expirySeconds?: number;
  metadata?: Record<string, string>;
}

export interface PresignedUploadResult {
  url: string;
  fields: Record<string, string>;
  expiresIn: number;
  uploadKey: string;
}

export interface ObjectMetadata {
  contentType: string;
  contentLength: number;
  lastModified?: Date;
}

export interface IS3Service {
  /** Generate a POST-style presigned URL for direct browser/mobile upload. */
  generatePresignedUploadUrl(params: PresignUploadParams): Promise<PresignedUploadResult>;

  /** Generate a GET-style presigned URL (for private S3 objects). */
  generatePresignedDownloadUrl(key: string, expirySeconds?: number): Promise<string>;

  /** Direct upload (used by URL-migration / backend-side ingest). */
  uploadObject(key: string, body: Buffer, contentType: string): Promise<string>;

  /** Direct download — returns the full object body. */
  downloadObject(key: string): Promise<Buffer>;

  /** Delete a single object. */
  deleteObject(key: string): Promise<void>;

  /** Server-side copy. */
  copyObject(sourceKey: string, destKey: string): Promise<void>;

  /** HEAD object — used in the upload-confirm flow. */
  objectExists(key: string): Promise<boolean>;

  /** HEAD metadata. */
  getObjectMetadata(key: string): Promise<ObjectMetadata>;
}
