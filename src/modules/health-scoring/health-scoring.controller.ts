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
import { CurrentUser, RequirePermissions, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import {
  BulkRecomputeDto,
  BulkRecomputeSchema,
  HealthFiltersDto,
  HealthFiltersSchema,
} from './dto/score-product.dto';
import { v1Rules } from './rules/v1-rules';
import { ScoringEngineService } from './services/scoring-engine.service';
import { HealthScoringService } from './services/health-scoring.service';

/**
 * BE-12 — Health Scoring HTTP surface.
 *
 *   GET  /api/v1/products/:productId/health             → cached or computed
 *   POST /api/v1/products/:productId/health/recompute   → force recompute
 *   POST /api/v1/products/health/bulk-recompute         → admin bulk
 *   GET  /api/v1/products/health/filter                 → filter cached rows
 *   GET  /api/v1/health-scoring/rules                   → current rule set
 *   GET  /api/v1/health-scoring/stats                   → aggregate stats
 *
 * Every handler runs behind the BE-08 guard stack
 * (`JwtAuthGuard + RolesGuard + PermissionsGuard`).
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class HealthScoringController {
  constructor(
    private readonly health: HealthScoringService,
    private readonly engine: ScoringEngineService,
  ) {}

  @Get('products/:productId/health')
  @Version('1')
  @RequirePermissions('products:read')
  async getAssessment(@Param('productId') productId: string): Promise<unknown> {
    const cached = await this.health.getAssessment(productId);
    if (cached) return cached;
    return this.health.scoreProduct(productId);
  }

  @Post('products/:productId/health/recompute')
  @Version('1')
  @HttpCode(200)
  @RequirePermissions('products:write')
  recompute(@Param('productId') productId: string): Promise<unknown> {
    return this.health.recomputeScore(productId);
  }

  @Post('products/health/bulk-recompute')
  @Version('1')
  @HttpCode(200)
  @Roles('admin', 'owner')
  @RequirePermissions('products:bulk-import')
  bulkRecompute(
    @Body(new ZodValidationPipe(BulkRecomputeSchema)) dto: BulkRecomputeDto,
  ): Promise<unknown> {
    return this.health.bulkScore(dto.productIds);
  }

  @Get('products/health/filter')
  @Version('1')
  @RequirePermissions('products:read')
  filter(
    @Query(new ZodValidationPipe(HealthFiltersSchema)) filters: HealthFiltersDto,
    @CurrentUser() _user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.health.filter(filters);
  }

  @Get('health-scoring/rules')
  @Version('1')
  @RequirePermissions('products:read')
  listRules(): {
    version: string;
    rules: Array<{
      id: string;
      name: string;
      category: string;
      weight: number;
    }>;
  } {
    return {
      version: v1Rules[0]?.version ?? '1.0.0',
      rules: v1Rules.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        weight: r.weight,
      })),
    };
  }

  @Get('health-scoring/stats')
  @Version('1')
  @Roles('admin', 'owner')
  @RequirePermissions('reports:read')
  getStats(): Promise<unknown> {
    return this.health.getStats();
  }
}
