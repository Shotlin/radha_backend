import { Injectable } from '@nestjs/common';

import { ValidationException } from '@/common/errors/business.exception';

import { MEDIA_MAX_BYTES, MEDIA_MIN_BYTES } from '../dto/media.dto';
import { ALLOWED_IMAGE_CONTENT_TYPES } from '../utils/file-key.utils';

export type DetectedFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown';

export interface ImageMetadata {
  format: DetectedFormat;
  /** Magic-number derived flag — true means we recognised the bytes. */
  recognised: boolean;
}

/**
 * BE-13 — Image upload validator.
 *
 * Two layers:
 *  1. Pre-presign: validate caller-declared content-type + size limits.
 *  2. Post-upload: validate the actual S3 bytes match a real image
 *     format (magic-number sniffing). This catches mislabelled
 *     uploads (e.g. .jpg extension on a PHP file).
 *
 * BE-23 will extend this with `sharp`-based dimension extraction and
 * orientation correction.
 */
@Injectable()
export class ImageValidatorService {
  validateContentType(contentType: string): void {
    const lower = contentType.toLowerCase();
    if (
      !ALLOWED_IMAGE_CONTENT_TYPES.includes(lower as (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number])
    ) {
      throw new ValidationException(`Unsupported content type: ${contentType}`, {
        field: 'contentType',
        value: contentType,
        expected: ALLOWED_IMAGE_CONTENT_TYPES.join(', '),
      });
    }
  }

  validateSize(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < MEDIA_MIN_BYTES) {
      throw new ValidationException('File too small', {
        field: 'contentLength',
        value: bytes,
        expected: `>= ${MEDIA_MIN_BYTES}`,
      });
    }
    if (bytes > MEDIA_MAX_BYTES) {
      throw new ValidationException('File too large', {
        field: 'contentLength',
        value: bytes,
        expected: `<= ${MEDIA_MAX_BYTES}`,
      });
    }
  }

  /**
   * Magic-number sniff — strict. Buffers smaller than 12 bytes can
   * never be a real image; reject early.
   */
  detectFormat(buffer: Buffer): ImageMetadata {
    if (buffer.length < 12) return { format: 'unknown', recognised: false };

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { format: 'jpeg', recognised: true };
    }
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { format: 'png', recognised: true };
    }
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { format: 'webp', recognised: true };
    }
    if (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) &&
      buffer[5] === 0x61
    ) {
      return { format: 'gif', recognised: true };
    }
    return { format: 'unknown', recognised: false };
  }

  /**
   * Throw if the buffer doesn't match a recognised image format OR
   * the format disagrees with the declared content-type.
   */
  validateImageBuffer(buffer: Buffer, declaredContentType: string): ImageMetadata {
    if (buffer.length < MEDIA_MIN_BYTES) {
      throw new ValidationException('Uploaded file is too small to be a valid image');
    }
    const meta = this.detectFormat(buffer);
    if (!meta.recognised) {
      throw new ValidationException('Uploaded bytes are not a recognised image format');
    }
    const expectedContentType = `image/${meta.format}`;
    if (
      declaredContentType.toLowerCase() !== expectedContentType &&
      // Accept jpeg ⇄ jpg
      !(meta.format === 'jpeg' && declaredContentType.toLowerCase() === 'image/jpg')
    ) {
      throw new ValidationException(
        `Uploaded image format ${meta.format} does not match declared content type ${declaredContentType}`,
        { field: 'contentType', value: declaredContentType, expected: expectedContentType },
      );
    }
    return meta;
  }
}
