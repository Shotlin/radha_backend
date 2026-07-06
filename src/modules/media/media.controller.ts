import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';

import {
  ConfirmUploadDto,
  ConfirmUploadSchema,
  MigrateFromUrlDto,
  MigrateFromUrlSchema,
  PresignUploadDto,
  PresignUploadSchema,
} from './dto/media.dto';
import { MediaService } from './media.service';
import { ImageProcessingProcessor } from './processors/image-processing.processor';
import { CdnInvalidatorService } from './services/cdn-invalidator.service';

/**
 * BE-13 — Media REST surface.
 *
 *   POST   /api/v1/media/presign           → Get presigned upload URL
 *   POST   /api/v1/media/:id/confirm       → Confirm upload completion
 *   GET    /api/v1/media/:id               → Read a media asset
 *   GET    /api/v1/media?ownerType&ownerId → List media for an owner
 *   DELETE /api/v1/media/:id               → Soft-delete + S3 cleanup
 *   POST   /api/v1/media/migrate-from-url  → Backend-side URL ingest
 */
@Controller('media')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly cdnInvalidator: CdnInvalidatorService,
    private readonly imageProcessing: ImageProcessingProcessor,
  ) {}

  @Post('presign')
  @Version('1')
  @HttpCode(200)
  @RequirePermissions('products:write')
  initiate(
    @Body(new ZodValidationPipe(PresignUploadSchema)) dto: PresignUploadDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    return this.media.initiateUpload(dto, userId, tenantId);
  }

  @Post(':id/confirm')
  @Version('1')
  @HttpCode(200)
  @RequirePermissions('products:write')
  confirm(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ConfirmUploadSchema)) body: ConfirmUploadDto,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    // Defence in depth: prefer the path param; reject mismatched body
    // by overwriting the dto's `mediaId` to the route-supplied id.
    return this.media.confirmUpload({ ...body, mediaId: id }, tenantId);
  }

  @Get(':id')
  @Version('1')
  @RequirePermissions('products:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string | null): Promise<unknown> {
    return this.media.getById(id, tenantId);
  }

  @Get()
  @Version('1')
  @RequirePermissions('products:read')
  list(
    @Query('ownerType') ownerType: string,
    @Query('ownerId') ownerId: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    return this.media.listByOwner(
      ownerType as
        | 'product'
        | 'user'
        | 'tenant'
        | 'tmp'
        | 'image_ocr_fallback'
        | 'barcode_learning',
      ownerId,
      tenantId,
    );
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(204)
  @RequirePermissions('products:delete')
  async remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<void> {
    await this.media.delete(id, userId, tenantId);
  }

  @Post('migrate-from-url')
  @Version('1')
  @HttpCode(200)
  @RequirePermissions('products:write')
  migrate(
    @Body(new ZodValidationPipe(MigrateFromUrlSchema)) dto: MigrateFromUrlDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    return this.media.migrateFromUrl(dto, userId, tenantId);
  }

  /* ───────── BE-23 — image processing + CDN ───────── */

  /**
   * Force re-process an existing media asset. Useful when:
   *   - The variant config changed and existing media should be
   *     regenerated.
   *   - The first processing run failed and the upstream issue is
   *     resolved.
   *   - The user uploaded a replacement image at the same key.
   *
   * Returns the new processing result (variants, sizes, ratio).
   */
  @Post(':id/reprocess')
  @Version('1')
  @HttpCode(200)
  @RequirePermissions('products:write')
  async reprocess(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    // Tenant scope check first — `findVisibleById` enforces it.
    await this.media.getById(id, tenantId);
    return this.imageProcessing.enqueue(id);
  }

  /**
   * Trigger CloudFront cache invalidation for a media asset's primary
   * key + every known variant. Admin-only because invalidations cost
   * money beyond the AWS free tier.
   */
  @Post(':id/invalidate')
  @Version('1')
  @HttpCode(200)
  @RequirePermissions('products:delete')
  async invalidate(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    await this.media.getById(id, tenantId);
    return this.cdnInvalidator.invalidateByMediaId(id);
  }

  /**
   * List the variant manifest for a media asset. Returns `null`
   * variants when processing hasn't completed yet — callers should
   * fall back to the `cdnUrl` on the parent view.
   */
  @Get(':id/variants')
  @Version('1')
  @RequirePermissions('products:read')
  async listVariants(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    return this.media.getVariantManifest(id, tenantId);
  }
}
