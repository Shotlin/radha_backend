import { Injectable, Logger } from '@nestjs/common';

import { ImageProcessorService } from '../services/image-processor.service';
import type { ProcessedImageResult } from '../types/media.types';

/**
 * BE-23 — Synchronous image-processing entry point with a Bull-shaped
 * API.
 *
 * v1 (today): runs in-process on the calling thread. The reprocess
 *             endpoint waits for the result; the upload-confirm flow
 *             can fire-and-forget by calling `enqueue(...)` and
 *             ignoring the resolved promise.
 *
 * v2 (BE-24): same `enqueue(...)` signature — the body becomes
 *             `bullQueue.add('process-image', { mediaId })` and a
 *             separate `@Processor('image-processing')` class on the
 *             worker process consumes the job. Consumers don't need
 *             to change.
 *
 * Retry semantics:
 *   - Sync v1   → no retry; failure surfaces immediately.
 *   - BE-24 BullMQ swap → `attempts: 3, backoff: { type: 'exponential' }`
 *     per the phase doc.
 */
@Injectable()
export class ImageProcessingProcessor {
  private readonly logger = new Logger(ImageProcessingProcessor.name);

  constructor(private readonly processor: ImageProcessorService) {}

  /**
   * Schedule (today: execute) image processing for a media id.
   * Returns the processed result so callers that *do* want to await
   * the outcome can. Fire-and-forget callers should swallow the
   * promise's rejection — failures are persisted on the row.
   */
  async enqueue(mediaId: string): Promise<ProcessedImageResult> {
    this.logger.log(`image.processing.enqueued mediaId=${mediaId}`);
    return this.processor.processImage(mediaId);
  }

  /**
   * BE-24 swap-in seam: when the BullMQ `@Processor` lands, this
   * method becomes the actual handler. Today it's just a façade.
   */
  async handleProcess(payload: { mediaId: string }): Promise<ProcessedImageResult> {
    return this.processor.processImage(payload.mediaId);
  }
}
