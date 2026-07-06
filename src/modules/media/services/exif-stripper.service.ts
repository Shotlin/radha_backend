import { Injectable, Logger } from '@nestjs/common';

import { loadSharp, type SharpModule } from '../utils/image-optimization.utils';

/**
 * BE-23 — Strip EXIF metadata before any processed bytes leave the
 * server.
 *
 * Why:
 *   - **Privacy**: GPS coordinates, device serial numbers, and
 *     timestamps live in EXIF. Customers don't want product photos
 *     to leak their store address.
 *   - **Bytes**: EXIF blobs can be 50–200 KB on phone uploads.
 *   - **Compatibility**: Some EXIF orientation flags ship rotated
 *     pixels that look correct in the camera roll but rotate weirdly
 *     in mobile WebViews. Auto-rotate normalises orientation before
 *     stripping.
 *
 * The implementation is a thin wrapper around Sharp:
 *   1. `.rotate()` — auto-orient pixels using the EXIF orientation
 *      tag, then drop the tag.
 *   2. `.withMetadata({})` — strip the rest. Sharp v0.32+ keeps the
 *      ICC profile by default which is the desired behaviour (color
 *      accuracy preserved).
 *
 * `sharp` is **dynamically loaded** so the API still boots without the
 * native binary installed. Mode `unavailable` returns the original
 * buffer unchanged with a warning — preferable to failing user
 * uploads outright on a missing optional dep.
 */
@Injectable()
export class ExifStripperService {
  private readonly logger = new Logger(ExifStripperService.name);
  private sharp: SharpModule | null | 'unavailable' = null;

  /**
   * Strip EXIF + auto-rotate. Returns the original buffer if Sharp is
   * not installed (logged at warn level).
   */
  async strip(buffer: Buffer): Promise<Buffer> {
    const sharp = await this.ensureSharp();
    if (!sharp) {
      this.logger.warn('exif.strip.sharp-unavailable bytes-returned-unchanged');
      return buffer;
    }
    try {
      return await sharp(buffer).rotate().withMetadata({}).toBuffer();
    } catch (err) {
      this.logger.warn(`exif.strip.failed err=${(err as Error).message}`);
      return buffer;
    }
  }

  /**
   * Returns true when the buffer carries an EXIF segment. Used by
   * tests and by the dashboard endpoint that surfaces "this image had
   * GPS data, we removed it".
   */
  async hasExif(buffer: Buffer): Promise<boolean> {
    const sharp = await this.ensureSharp();
    if (!sharp) return false;
    try {
      const meta = await sharp(buffer).metadata();
      return Boolean(meta.exif && meta.exif.length > 0);
    } catch {
      return false;
    }
  }

  private async ensureSharp(): Promise<SharpModule | null> {
    if (this.sharp === 'unavailable') return null;
    if (this.sharp) return this.sharp;
    const loaded = await loadSharp();
    this.sharp = loaded ?? 'unavailable';
    return loaded;
  }
}
