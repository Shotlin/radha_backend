import { Controller, Get, Param, Query, UseGuards, Version } from '@nestjs/common';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { PermissionsService } from '@/modules/auth/services/permissions.service';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import {
  AutocompleteDto,
  AutocompleteSchema,
  PopularProductsQueryDto,
  PopularProductsQuerySchema,
  SearchProductsDto,
  SearchProductsSchema,
} from '../dto/search.dto';
import { ProductSearchService } from '../services/product-search.service';

/**
 * BE-14 — Product search REST surface.
 *
 *   GET /api/v1/products/search          → full search (FTS + trigram + filters)
 *   GET /api/v1/products/autocomplete    → prefix suggestions
 *   GET /api/v1/products/facets          → faceted counts (categories/brands/grades)
 *   GET /api/v1/products/popular         → tenant-scoped popularity ledger
 *   GET /api/v1/products/:id/similar     → similar products (trigram + brand + category)
 *
 * NOTE: paths are deliberately distinct from the existing
 * `ProductsController` paths (`GET /api/v1/products`, `GET /api/v1/products/:id`,
 * etc.) to avoid route conflicts. Both controllers register under the
 * `products` base path; static segments (`/search`, `/autocomplete`, …)
 * resolve before the `:id` catch-all.
 */
@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class SearchController {
  /** Free-tier hard cap (Req 39 — top-20 non-overridable for free). */
  private static readonly FREE_LIMIT_CAP = 20;
  /** Paid-tier cap. */
  private static readonly PAID_LIMIT_CAP = 100;

  constructor(
    private readonly search: ProductSearchService,
    private readonly permissions: PermissionsService,
  ) {}

  @Get('search')
  @Version('1')
  @RequirePermissions('products:read')
  async fullSearch(
    @Query(new ZodValidationPipe(SearchProductsSchema)) query: SearchProductsDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    const limit = this.capLimit(query.limit, user);
    return this.search.search({ ...query, limit }, tenantId, user.id);
  }

  @Get('autocomplete')
  @Version('1')
  @RequirePermissions('products:read')
  async autocomplete(
    @Query(new ZodValidationPipe(AutocompleteSchema)) query: AutocompleteDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    return this.search.autocomplete(query, tenantId, user.id);
  }

  @Get('facets')
  @Version('1')
  @RequirePermissions('products:read')
  async facets(@CurrentTenant() tenantId: string | null): Promise<unknown> {
    return this.search.getFacets(tenantId);
  }

  @Get('popular')
  @Version('1')
  @RequirePermissions('products:read')
  async popular(
    @Query(new ZodValidationPipe(PopularProductsQuerySchema)) query: PopularProductsQueryDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    const limit = this.capLimit(query.limit, user);
    return this.search.getPopular(tenantId, limit);
  }

  @Get(':id/similar')
  @Version('1')
  @RequirePermissions('products:read')
  async similar(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    const limit = this.capLimit(10, user);
    return this.search.findSimilar(id, tenantId, limit);
  }

  private capLimit(requested: number, user: AuthenticatedUser): number {
    const cap = this.permissions.getEntitlements(user).comprehensiveScanAccess
      ? SearchController.PAID_LIMIT_CAP
      : SearchController.FREE_LIMIT_CAP;
    return Math.min(requested, cap);
  }
}
