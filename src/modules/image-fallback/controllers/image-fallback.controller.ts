import { Body, Controller, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import {
  ImageFallbackDto,
  ImageFallbackResponseDto,
  ImageFallbackSchema,
} from '../dto/image-fallback.dto';
import { ImageFallbackService } from '../services/image-fallback.service';

/**
 * BE-45 — Image OCR Scan Fallback REST controller.
 *
 *   POST /api/v1/scan/image-fallback   — { s3ObjectKey, locale? }
 *
 * Transport-only. The DTO is validated by `ZodValidationPipe`; auth
 * is enforced by `JwtAuthGuard` per the BE-45 brief. All business
 * logic lives in `ImageFallbackService`.
 *
 * The response shape always carries `matched`. On a hit the body
 * includes `ean`, `productName`, `brand`, and `source`; on a miss
 * we return `{ matched: false, source: 'none' }` so the Mobile_App
 * can fall through to manual product creation.
 */
@Controller('scan')
@UseGuards(JwtAuthGuard)
export class ImageFallbackController {
  constructor(private readonly service: ImageFallbackService) {}

  @Post('image-fallback')
  @Version('1')
  @HttpCode(200)
  async fallback(
    @Body(new ZodValidationPipe(ImageFallbackSchema)) dto: ImageFallbackDto,
  ): Promise<ImageFallbackResponseDto> {
    return this.service.identify(dto);
  }
}
