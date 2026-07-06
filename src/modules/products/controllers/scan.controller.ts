import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Query,
  UseGuards,
  Version,
  forwardRef,
} from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { LoggerService } from '@/logging/logger.service';
import { CurrentTenant, CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsService } from '@/modules/auth/services/permissions.service';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';
import { HealthScoringService } from '@/modules/health-scoring/services/health-scoring.service';

import { ScanModeToggleDto, ScanModeToggleSchema } from '../dto/create-product.dto';
import { ProductLookupService } from '../services/product-lookup.service';
import { ScanMode, ScanModePreferenceService } from '../services/scan-mode-preference.service';

interface ScanResponse {
  mode: ScanMode;
  ean: string;
  found: boolean;
  product: unknown;
  comprehensive?: unknown;
}

/**
 * BE-10 v2 ADDENDUM (Req 4) — `GET /api/v1/products/{ean}/scan?mode=basic|comprehensive`.
 *
 * Owns:
 *   - mode resolution (default `basic` when omitted),
 *   - the entitlement gate that returns 402 PAYMENT_REQUIRED for Free
 *     Consumers requesting comprehensive,
 *   - per-user mode preference persistence,
 *   - delegation to BE-12 `HealthScoringService` to fill in the
 *     comprehensive payload (PROS / CONS / age-band safety /
 *     consumption guidance / allergen-profile matches).
 *
 * BE-41 (Healthier Alternatives) plugs into the
 * `comprehensive.healthierAlternatives` slot when it lands. Until
 * then BE-12 returns an empty array there.
 */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ScanController {
  constructor(
    private readonly lookup: ProductLookupService,
    private readonly permissions: PermissionsService,
    private readonly preferences: ScanModePreferenceService,
    private readonly logger: LoggerService,
    @Inject(forwardRef(() => HealthScoringService))
    private readonly health: HealthScoringService,
  ) {}

  @Get(':ean/scan')
  @Version('1')
  async scan(
    @Param('ean') ean: string,
    @Query('mode') modeQuery: string | undefined,
    @Query('allergenProfileId') allergenProfileId: string | undefined,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ScanResponse> {
    const requested: ScanMode = modeQuery === 'comprehensive' ? 'comprehensive' : 'basic';
    if (requested === 'comprehensive') {
      const ent = this.permissions.getEntitlements(user);
      if (!ent.comprehensiveScanAccess) {
        throw new BusinessException(
          ErrorCode.PAYMENT_REQUIRED,
          'Comprehensive scan requires Premium Consumer or higher',
          { metadata: { tier: user.subscriptionTier } },
        );
      }
    }

    const result = await this.lookup.lookupByEan(ean, tenantId, {
      includeNutrition: true,
    });

    const base: ScanResponse = {
      mode: requested,
      ean,
      found: result.found,
      product: result.found ? result.product : null,
    };
    if (requested === 'basic' || !result.found || !result.product) return base;

    // Comprehensive: delegate to BE-12. Failures fall back to a
    // partial payload so a scoring error never breaks the scan
    // endpoint — the basic data still surfaces.
    try {
      const comprehensive = await this.health.scoreComprehensive(
        result.product.ean,
        tenantId,
        user.id,
        { allergenProfileId },
      );
      return { ...base, comprehensive };
    } catch (err) {
      this.logger.error('scan.comprehensive.failed', {
        ean,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return {
        ...base,
        comprehensive: {
          ready: false,
          reason: 'health_scoring_unavailable',
        },
      };
    }
  }

  @Put('scan-mode-preference')
  @Version('1')
  @HttpCode(200)
  setPreference(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(ScanModeToggleSchema)) dto: ScanModeToggleDto,
  ): Promise<{ mode: ScanMode }> {
    return this.preferences.set(userId, dto.mode);
  }
}
