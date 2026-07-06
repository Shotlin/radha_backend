import type { MediaAssetRow } from '@/db/schema/media-assets';

export type MediaOwnerType =
  | 'product'
  | 'user'
  | 'tenant'
  | 'tmp'
  | 'image_ocr_fallback'
  | 'barcode_learning';

export type MediaStatus = 'pending' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted';

export type ImageVariant = 'thumbnail' | 'medium' | 'full';

export interface MediaVariants {
  thumbnail: string;
  medium: string;
  full: string;
}

export interface UploadInitResult {
  mediaId: string;
  uploadUrl: string;
  uploadFields: Record<string, string>;
  expiresIn: number;
  cdnUrl: string;
  s3Key: string;
}

export interface MediaAssetView {
  id: string;
  tenantId: string | null;
  ownerType: MediaOwnerType;
  ownerId: string | null;
  status: MediaStatus;
  contentType: string;
  contentLength: number;
  s3Key: string;
  cdnUrl: string;
  variants: MediaVariants;
  uploadedAt: Date | null;
  processedAt: Date | null;
  width: number | null;
  height: number | null;
}

/** Internal — narrow row type ready to be mapped to a view. */
export type MediaAssetEntity = MediaAssetRow;

/* ───── BE-23 — Image processing contracts ───── */

export type ProcessedVariantName = 'thumbnail' | 'small' | 'medium' | 'large' | 'original';

export interface VariantInfo {
  s3Key: string;
  cdnUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  format: string;
}

export type ProcessedVariants = Record<ProcessedVariantName, VariantInfo>;

export interface ProcessedImageResult {
  mediaId: string;
  variants: ProcessedVariants;
  totalSizeBytes: number;
  optimizationRatio: number;
  durationMs: number;
}

export interface InvalidationResult {
  invalidationId: string;
  paths: string[];
  status: 'in-progress' | 'completed' | 'skipped';
}

export interface VariantListView {
  mediaId: string;
  status: MediaStatus;
  variants: ProcessedVariants | null;
  width: number | null;
  height: number | null;
  processedAt: Date | null;
}
