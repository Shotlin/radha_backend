import { z } from 'zod';

import { ALLOWED_IMAGE_CONTENT_TYPES } from '@/modules/media/utils/file-key.utils';
import { MEDIA_MAX_BYTES, MEDIA_MIN_BYTES } from '@/modules/media/dto/media.dto';

/**
 * BE-56 v2 — body of `POST /api/v1/products/learn/presign`.
 *
 * A narrower sibling of `PresignUploadSchema` (`media/dto/media.dto.ts`):
 * no `ownerType`/`ownerId` from the client. The consumer-submission
 * controller fixes `ownerType: 'barcode_learning'` server-side before
 * delegating to `MediaService.initiateUpload()`.
 *
 * Why not just call `/media/presign` directly? That endpoint requires
 * the `products:write` permission, which the `consumer` role (and
 * `staff`) don't have — correctly, since it's the general-purpose
 * entry point for privileged catalog-image management. This endpoint
 * is scoped to exactly one owner type or the barcode-learning
 * submission flow, so it's safe to open to any authenticated
 * submitter role without widening `products:write` itself.
 */
export const SubmissionPresignSchema = z
  .object({
    contentType: z.enum(ALLOWED_IMAGE_CONTENT_TYPES),
    contentLength: z.coerce
      .number()
      .int()
      .min(MEDIA_MIN_BYTES, `Files must be at least ${MEDIA_MIN_BYTES} bytes`)
      .max(MEDIA_MAX_BYTES, `Files cannot exceed ${MEDIA_MAX_BYTES} bytes`),
    filename: z.string().min(1).max(255).optional(),
  })
  .strict();

export type SubmissionPresignDto = z.infer<typeof SubmissionPresignSchema>;
