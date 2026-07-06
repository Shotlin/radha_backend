import { z } from 'zod';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '../utils/file-key.utils';

export const MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const MEDIA_MIN_BYTES = 100;

const ALLOWED_OWNER_TYPES = [
  'product',
  'user',
  'tenant',
  'tmp',
  'image_ocr_fallback',
  'barcode_learning',
] as const;

export const PresignUploadSchema = z.object({
  ownerType: z.enum(ALLOWED_OWNER_TYPES),
  ownerId: z.string().uuid().optional(),
  contentType: z.enum(ALLOWED_IMAGE_CONTENT_TYPES),
  contentLength: z.coerce
    .number()
    .int()
    .min(MEDIA_MIN_BYTES, `Files must be at least ${MEDIA_MIN_BYTES} bytes`)
    .max(MEDIA_MAX_BYTES, `Files cannot exceed ${MEDIA_MAX_BYTES} bytes`),
  filename: z.string().min(1).max(255).optional(),
});
export type PresignUploadDto = z.infer<typeof PresignUploadSchema>;

export const ConfirmUploadSchema = z.object({
  mediaId: z.string().uuid(),
});
export type ConfirmUploadDto = z.infer<typeof ConfirmUploadSchema>;

export const MigrateFromUrlSchema = z.object({
  url: z.string().url().max(500),
  productId: z.string().uuid(),
  ownerType: z.enum(['product']).default('product'),
});
export type MigrateFromUrlDto = z.infer<typeof MigrateFromUrlSchema>;
