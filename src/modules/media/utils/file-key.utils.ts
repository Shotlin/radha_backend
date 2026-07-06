import { randomUUID } from 'crypto';

import type { MediaOwnerType } from '../types/media.types';

const CONTENT_TYPE_TO_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const ALLOWED_IMAGE_CONTENT_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]) as readonly ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Pick the file extension for a content type. Defaults to `bin` for
 * unknown types (caller should validate the content-type whitelist
 * BEFORE calling this helper).
 */
export const extensionForContentType = (contentType: string): string =>
  CONTENT_TYPE_TO_EXT[contentType.toLowerCase()] ?? 'bin';

export interface BuildKeyParams {
  tenantId: string | null;
  ownerType: MediaOwnerType;
  ownerId?: string | null;
  contentType: string;
  /** Optional caller-supplied uuid (used for idempotency in URL migrations). */
  mediaId?: string;
}

export interface BuildKeyResult {
  key: string;
  mediaId: string;
}

/**
 * Build the canonical S3 key for an upload.
 *
 * Layout:
 *   `<tenant-or-global>/<owner-type>/<owner-id-or-shard>/<media-id>.<ext>`
 *
 * - `tenant-or-global`  → `tenantId` when present, `global` otherwise.
 * - Owner-id is included when supplied so all media for a single
 *   product / user / etc lives under one prefix (helps with bulk
 *   delete + lifecycle policies).
 * - When owner-id is missing we shard by the first 2 chars of the
 *   media-id to avoid hot S3 prefixes.
 */
export const buildS3Key = (params: BuildKeyParams): BuildKeyResult => {
  const mediaId = params.mediaId ?? randomUUID();
  const ext = extensionForContentType(params.contentType);
  const tenantSegment = params.tenantId ?? 'global';
  const owner = params.ownerId ?? `_/${mediaId.slice(0, 2)}`;
  const key = `${tenantSegment}/${params.ownerType}/${owner}/${mediaId}.${ext}`;
  return { key, mediaId };
};

/**
 * Build the variant key for a given primary key:
 *   `tenant/product/abc.jpg` + `thumbnail` → `tenant/product/abc.thumbnail.jpg`.
 */
export const buildVariantKey = (
  primaryKey: string,
  variant: 'thumbnail' | 'medium' | 'full',
): string => {
  if (variant === 'full') return primaryKey;
  const lastDot = primaryKey.lastIndexOf('.');
  if (lastDot === -1) return `${primaryKey}.${variant}`;
  return `${primaryKey.slice(0, lastDot)}.${variant}${primaryKey.slice(lastDot)}`;
};
