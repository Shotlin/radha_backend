import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
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

import {
  CreateProductDto,
  CreateProductSchema,
  ProductLookupBatchDto,
  ProductLookupBatchSchema,
  ProductSearchQueryDto,
  ProductSearchQuerySchema,
  UpdateProductDto,
  UpdateProductSchema,
} from './dto/create-product.dto';
import { ProductLookupService } from './services/product-lookup.service';
import { ProductsService } from './products.service';

@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly lookup: ProductLookupService,
  ) {}

  @Get('lookup/:ean')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'consumer', 'admin')
  @RequirePermissions('products:read')
  async lookupByEan(@Param('ean') ean: string, @CurrentTenant() tenantId: string | null) {
    return this.lookup.lookupByEan(ean, tenantId, { includeNutrition: true });
  }

  @Post('lookup/batch')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  async lookupBatch(
    @Body(new ZodValidationPipe(ProductLookupBatchSchema)) dto: ProductLookupBatchDto,
    @CurrentTenant() tenantId: string | null,
  ) {
    const map = await this.lookup.lookupBatch(dto.eans, tenantId);
    return Object.fromEntries(map);
  }

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  async search(
    @Query(new ZodValidationPipe(ProductSearchQuerySchema)) query: ProductSearchQueryDto,
    @CurrentTenant() tenantId: string | null,
  ) {
    return this.products.search(tenantId, query);
  }

  @Get(':id')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  @RequirePermissions('products:read')
  async get(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string | null,
  ) {
    return this.products.findById(tenantId, id);
  }

  @Post()
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  async create(
    @Body(new ZodValidationPipe(CreateProductSchema)) dto: CreateProductDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.products.create(tenantId, userId, dto);
  }

  @Patch(':id')
  @Version('1')
  @Roles('owner', 'manager', 'admin')
  @RequirePermissions('products:write')
  @RequireTenant()
  async update(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateProductSchema)) dto: UpdateProductDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.products.update(tenantId, userId, id, dto);
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'admin')
  @RequirePermissions('products:delete')
  @RequireTenant()
  async remove(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.products.softDelete(tenantId, userId, id);
  }
}
