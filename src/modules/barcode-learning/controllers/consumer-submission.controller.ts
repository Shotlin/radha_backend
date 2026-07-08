import { Body, Controller, HttpCode, Param, Post, UseGuards, Version } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentTenant, CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { ConfirmUploadSchema } from '@/modules/media/dto/media.dto';
import { MediaAssetView, UploadInitResult } from '@/modules/media/types/media.types';
import { MediaService } from '@/modules/media/media.service';

import { FlagProductDto, FlagProductSchema } from '../dto/flag-product.dto';
import { SubmissionPresignDto, SubmissionPresignSchema } from '../dto/submission-media.dto';
import { SubmitBarcodeDto, SubmitBarcodeSchema } from '../dto/submit-barcode.dto';
import {
  BarcodeLearningService,
  FlagResultDto,
  SubmissionDto,
} from '../services/barcode-learning.service';

/**
 * BE-56 — Consumer-facing endpoints for the Barcode Learning queue.
 *
 *   POST /api/v1/products/learn                        — submit a community barcode entry
 *   POST /api/v1/products/learn/presign                 — presign a photo upload (BE-56 v2)
 *   POST /api/v1/products/learn/media/:mediaId/confirm  — confirm that upload (BE-56 v2)
 *   POST /api/v1/products/:ean/flag                     — flag an existing entry as incorrect
 *
 * Open to `consumer` plus the business roles (`staff`/`manager`/
 * `owner`/`admin`) — the retail-audit use case (a shop's own staff
 * scanning real inventory) is at least as common as a personal
 * consumer hitting an unrecognised barcode.
 *
 * The presign/confirm pair exists here, instead of the client calling
 * `/media/presign` directly, because that general-purpose endpoint
 * requires `products:write` — a permission `consumer` and `staff`
 * don't have, correctly, since it also guards privileged catalog
 * image management. This pair is hard-scoped to
 * `ownerType: 'barcode_learning'` server-side, so it's safe to open
 * without touching that broader gate.
 *
 * The HTTP transport is intentionally thin: validation via Zod,
 * delegation to `BarcodeLearningService` / `MediaService` for
 * everything else (rate-limit, audit log, threshold tracking, S3).
 */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('consumer', 'staff', 'manager', 'owner', 'admin')
export class ConsumerSubmissionController {
  constructor(
    private readonly svc: BarcodeLearningService,
    private readonly media: MediaService,
  ) {}

  @Post('learn')
  @Version('1')
  @HttpCode(201)
  // Burst throttle on top of the existing 10/day DB-counted quota
  // (BarcodeLearningService.MAX_SUBMISSIONS_PER_DAY) -- that limit is
  // untouched; this only stops rapid-fire abuse within a single day's
  // allowance.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  submit(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(SubmitBarcodeSchema)) dto: SubmitBarcodeDto,
  ): Promise<SubmissionDto> {
    return this.svc.submit(userId, dto);
  }

  @Post('learn/presign')
  @Version('1')
  @HttpCode(200)
  presignSubmissionPhoto(
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
    @Body(new ZodValidationPipe(SubmissionPresignSchema)) dto: SubmissionPresignDto,
  ): Promise<UploadInitResult> {
    return this.media.initiateUpload(
      { ownerType: 'barcode_learning', ...dto },
      userId,
      tenantId,
    );
  }

  @Post('learn/media/:mediaId/confirm')
  @Version('1')
  @HttpCode(200)
  confirmSubmissionPhoto(
    @Param('mediaId') mediaId: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<MediaAssetView> {
    return this.media.confirmUpload(
      ConfirmUploadSchema.parse({ mediaId }),
      tenantId,
    );
  }

  @Post(':ean/flag')
  @Version('1')
  @HttpCode(200)
  flag(
    @CurrentUser('id') userId: string,
    @Param('ean') ean: string,
    @Body(new ZodValidationPipe(FlagProductSchema)) dto: FlagProductDto,
  ): Promise<FlagResultDto> {
    return this.svc.flag(userId, ean, dto);
  }
}
