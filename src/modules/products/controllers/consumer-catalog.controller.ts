import { Controller, Get, Query, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { RequirePermissions, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import { CatalogBrowseQueryDto, CatalogBrowseQuerySchema } from '../dto/consumer-catalog.dto';
import { ConsumerCatalogService } from '../services/consumer-catalog.service';

/**
 * Consumer Catalog — browse-without-scan REST surface.
 *
 *   GET /api/v1/catalog/categories
 *   GET /api/v1/catalog/products?category=&q=&sort=&cursor=&limit=
 *
 * Authenticated and **consumer-accessible** (unlike the business-scoped
 * `GET /products`, which is owner/manager/staff/auditor only). Reads the global
 * catalog only — no tenant requirement, so a tenant-less personal user can
 * browse. The product detail behind a browse tap reuses the existing
 * consumer-accessible `GET /products/lookup/:ean`.
 */
@Controller('catalog')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class ConsumerCatalogController {
  constructor(private readonly catalog: ConsumerCatalogService) {}

  @Get('categories')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'consumer', 'admin')
  @RequirePermissions('products:read')
  async categories() {
    return this.catalog.listCategories();
  }

  @Get('products')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'consumer', 'admin')
  @RequirePermissions('products:read')
  async products(
    @Query(new ZodValidationPipe(CatalogBrowseQuerySchema)) query: CatalogBrowseQueryDto,
  ) {
    return this.catalog.browse(query);
  }
}
