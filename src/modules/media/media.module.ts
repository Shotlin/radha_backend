import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { MediaController } from './media.controller';
import { MediaRepository } from './media.repository';
import { MediaService } from './media.service';
import { ImageProcessingProcessor } from './processors/image-processing.processor';
import { CdnInvalidatorService } from './services/cdn-invalidator.service';
import { ExifStripperService } from './services/exif-stripper.service';
import { ImageProcessorService } from './services/image-processor.service';
import { ImageValidatorService } from './services/image-validator.service';
import { ImageVariantsService } from './services/image-variants.service';

/**
 * BE-13 + BE-23 — Media module.
 *
 * AwsModule (S3 + CloudFront URL builder + CloudFrontClientService for
 * invalidations) is `@Global()`, so it doesn't need an explicit import
 * here. AuthModule is imported because the controller uses the BE-08
 * guard stack and the `@CurrentUser` / `@CurrentTenant` decorators
 * that read `req.user` populated by `JwtAuthGuard`.
 *
 * BE-23 surface added:
 *   - `ImageVariantsService`        — variant config source of truth.
 *   - `ExifStripperService`         — privacy-preserving metadata strip.
 *   - `ImageProcessorService`       — Sharp pipeline orchestrator.
 *   - `CdnInvalidatorService`       — CloudFront invalidations.
 *   - `ImageProcessingProcessor`    — sync v1 with Bull-shaped API
 *                                     (BE-24 swaps in BullMQ).
 *
 * Nothing here imports `sharp` or `@aws-sdk/client-cloudfront` at
 * module-load time — both packages are dynamic-imported on first use,
 * so the API process boots cleanly without them installed.
 */
@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [
    MediaService,
    MediaRepository,
    ImageValidatorService,
    ImageVariantsService,
    ExifStripperService,
    ImageProcessorService,
    CdnInvalidatorService,
    ImageProcessingProcessor,
  ],
  exports: [
    MediaService,
    MediaRepository,
    ImageValidatorService,
    ImageVariantsService,
    ExifStripperService,
    ImageProcessorService,
    CdnInvalidatorService,
    ImageProcessingProcessor,
  ],
})
export class MediaModule {}
