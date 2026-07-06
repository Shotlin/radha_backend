import {
  Body,
  Controller,
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
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import { AiService } from './ai.service';
import {
  ImageFallbackRequestDto,
  ImageFallbackRequestSchema,
  IngredientExplanationQueryDto,
  IngredientExplanationQuerySchema,
  IngredientSlugSchema,
  LabelAnalyzeRequestDto,
  LabelAnalyzeRequestSchema,
  LabelTextAnalyzeRequestDto,
  LabelTextAnalyzeRequestSchema,
  LimitCheckQueryDto,
  LimitCheckQuerySchema,
  OcrRequestDto,
  OcrRequestSchema,
  ReportSummaryRequestDto,
  ReportSummaryRequestSchema,
  UsageQueryDto,
  UsageQuerySchema,
} from './dto/ai.dto';

/**
 * BE-22 — AI/OCR REST surface.
 *
 *   POST /api/v1/ai/ocr/expiry          OCR for an expiry date
 *   POST /api/v1/ai/ocr/batch           OCR for a batch number
 *   POST /api/v1/ai/ocr/text            Generic OCR
 *   POST /api/v1/ai/label/analyze       Label analysis (paid)
 *   POST /api/v1/ai/image-fallback      Req 38 backing endpoint
 *   POST /api/v1/ai/report/summary      LLM report summary
 *   GET  /api/v1/ai/ingredients/:slug/explanation   Req 45 backing endpoint
 *   GET  /api/v1/ai/usage               Tenant usage stats
 *   GET  /api/v1/ai/limits              Single-operation limit probe
 *
 * Static segments are routed before parameterised ones to avoid
 * `usage` being interpreted as a slug.
 *
 * Permission gates use existing BE-08 catalog entries:
 *   - `products:read`  for OCR / label analysis (product-reading domain)
 *   - `consumer:scan`  for image fallback + ingredient explanation
 *   - `reports:generate` for LLM summaries
 *   - `owner:dashboard` for usage / limit reporting
 */
@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  /* ─────────────────── OCR ─────────────────── */

  @Post('ocr/expiry')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin', 'consumer')
  @RequirePermissions('products:read')
  @RequireTenant()
  ocrExpiry(@Body(new ZodValidationPipe(OcrRequestSchema)) dto: OcrRequestDto): Promise<unknown> {
    return this.ai.extractExpiryDate(dto.mediaId, {
      preExtractedText: dto.preExtractedText,
      preExtractedConfidence: dto.preExtractedConfidence,
      fallbackToPaid: dto.fallbackToPaid,
      language: dto.language,
    });
  }

  @Post('ocr/batch')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  ocrBatch(@Body(new ZodValidationPipe(OcrRequestSchema)) dto: OcrRequestDto): Promise<unknown> {
    return this.ai.extractBatchNumber(dto.mediaId, {
      preExtractedText: dto.preExtractedText,
      preExtractedConfidence: dto.preExtractedConfidence,
      fallbackToPaid: dto.fallbackToPaid,
      language: dto.language,
    });
  }

  @Post('ocr/text')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin', 'consumer')
  @RequirePermissions('products:read')
  @RequireTenant()
  ocrText(@Body(new ZodValidationPipe(OcrRequestSchema)) dto: OcrRequestDto): Promise<unknown> {
    return this.ai.extractText(dto.mediaId, {
      preExtractedText: dto.preExtractedText,
      preExtractedConfidence: dto.preExtractedConfidence,
      fallbackToPaid: dto.fallbackToPaid,
      language: dto.language,
    });
  }

  /* ─────────────────── Label / image fallback ─────────────────── */

  @Post('label/analyze')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:read')
  @RequireTenant()
  analyzeLabel(
    @Body(new ZodValidationPipe(LabelAnalyzeRequestSchema)) dto: LabelAnalyzeRequestDto,
  ): Promise<unknown> {
    return this.ai.analyzeProductLabel(dto.mediaId);
  }

  @Post('image-fallback')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin', 'consumer')
  @RequirePermissions('consumer:scan')
  @RequireTenant()
  imageFallback(
    @Body(new ZodValidationPipe(ImageFallbackRequestSchema)) dto: ImageFallbackRequestDto,
  ): Promise<unknown> {
    return this.ai.imageFallbackScan(dto.mediaId);
  }

  /**
   * Consumer "scan the label" fallback — analyze an on-device OCR transcript.
   * Used when a barcode lookup misses: the mobile reads the label with ML Kit
   * and posts the text here for a cheap LLM (Gemini) structured analysis.
   */
  @Post('label/analyze-text')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin', 'consumer')
  @RequirePermissions('consumer:scan')
  @RequireTenant()
  analyzeLabelText(
    @Body(new ZodValidationPipe(LabelTextAnalyzeRequestSchema)) dto: LabelTextAnalyzeRequestDto,
  ): Promise<unknown> {
    return this.ai.analyzeLabelText(dto.transcript, dto.locale);
  }

  /* ─────────────────── LLM ─────────────────── */

  @Post('report/summary')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('reports:generate')
  @RequireTenant()
  reportSummary(
    @Body(new ZodValidationPipe(ReportSummaryRequestSchema)) dto: ReportSummaryRequestDto,
  ): Promise<unknown> {
    return this.ai.generateReportSummary(dto);
  }

  /* ─────────────────── Usage / limits — static segments first ─────────────────── */

  @Get('usage')
  @Version('1')
  @Roles('owner', 'admin')
  @RequirePermissions('owner:dashboard')
  @RequireTenant()
  usage(
    @Query(new ZodValidationPipe(UsageQuerySchema)) query: UsageQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setUTCDate(1);
    defaultFrom.setUTCHours(0, 0, 0, 0);
    return this.ai.getUsage(tenantId, {
      from: query.from ? new Date(query.from) : defaultFrom,
      to: query.to ? new Date(query.to) : now,
    });
  }

  @Get('limits')
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('owner:dashboard')
  @RequireTenant()
  limit(
    @Query(new ZodValidationPipe(LimitCheckQuerySchema)) query: LimitCheckQueryDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.ai.checkLimit(tenantId, query.operation);
  }

  /* ─────────────────── Ingredient explainer (Req 45) ─────────────────── */

  @Get('ingredients/:slug/explanation')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'admin', 'consumer')
  @RequirePermissions('consumer:scan')
  @RequireTenant()
  explainIngredient(
    @Param('slug') rawSlug: string,
    @Query(new ZodValidationPipe(IngredientExplanationQuerySchema))
    query: IngredientExplanationQueryDto,
    @CurrentUser('id') _userId: string,
  ): Promise<unknown> {
    void _userId;
    const slug = IngredientSlugSchema.parse(rawSlug);
    return this.ai.explainIngredient(slug, query.locale);
  }
}
