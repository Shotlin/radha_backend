import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import { products, type ProductRow } from '@/db/schema/products';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  CreateProductDto,
  ProductSearchQueryDto,
  UpdateProductDto,
} from './dto/create-product.dto';
import { ProductsRepository } from './products.repository';
import { ProductNutritionRepository } from './repositories/product-nutrition.repository';
import { normaliseEan, validateEan } from './utils/ean.utils';

@Injectable()
export class ProductsService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly nutrition: ProductNutritionRepository,
    private readonly db: DbService,
    private readonly audit: AuditLogService,
  ) {}

  async create(tenantId: string, byUserId: string, dto: CreateProductDto): Promise<ProductRow> {
    const validation = validateEan(dto.ean);
    if (!validation.valid) {
      throw new BusinessException(ErrorCode.INVALID_EAN_FORMAT, validation.error ?? 'Invalid EAN', {
        field: 'ean',
        value: dto.ean,
      });
    }
    const ean = normaliseEan(dto.ean);

    const existing = await this.products.findVisibleByEan(ean, tenantId);
    if (existing && existing.tenantId === tenantId) {
      throw new BusinessException(
        ErrorCode.EAN_ALREADY_EXISTS,
        'Product with this EAN already exists in tenant',
        { metadata: { ean } },
      );
    }

    const product = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(products)
        .values({
          tenantId,
          ean,
          name: dto.name,
          brand: dto.brand,
          manufacturer: dto.manufacturer,
          categoryId: dto.categoryId,
          subCategory: dto.subCategory,
          productType: dto.productType,
          imageUrl: dto.imageUrl,
          description: dto.description,
          packageSize: dto.packageSize,
          packageUnit: dto.packageUnit,
          packageType: dto.packageType,
          status: 'active',
          dataSource: 'manual',
          createdBy: byUserId,
        })
        .returning();
      return row as ProductRow;
    });

    if (dto.nutrition) {
      await this.nutrition.upsertForProduct(product.id, {
        ...this.nutritionToRow(dto.nutrition),
        dataSource: 'manual',
      });
    }

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'Product',
      resourceId: product.id,
      userId: byUserId,
      tenantId,
      success: true,
      metadata: { ean },
    });
    return product;
  }

  async findById(tenantId: string | null, id: string): Promise<ProductRow> {
    const row = await this.products.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('Product', id);
    return row;
  }

  async update(
    tenantId: string,
    byUserId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductRow> {
    const existing = await this.products.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('Product', id);
    if (existing.tenantId === null) {
      throw new BusinessException(
        ErrorCode.FORBIDDEN,
        'Cannot edit a global catalog product. Create a tenant override instead.',
      );
    }
    const updated = await this.products.update(id, {
      name: dto.name,
      brand: dto.brand,
      manufacturer: dto.manufacturer,
      categoryId: dto.categoryId,
      subCategory: dto.subCategory,
      productType: dto.productType,
      imageUrl: dto.imageUrl,
      description: dto.description,
      packageSize: dto.packageSize,
      packageUnit: dto.packageUnit,
      packageType: dto.packageType,
      status: dto.status,
      isVerified: dto.isVerified,
      updatedBy: byUserId,
    });
    if (dto.nutrition) {
      await this.nutrition.upsertForProduct(id, this.nutritionToRow(dto.nutrition));
    }
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'Product',
      resourceId: id,
      userId: byUserId,
      tenantId,
      success: true,
    });
    return updated;
  }

  async softDelete(tenantId: string, byUserId: string, id: string): Promise<void> {
    const existing = await this.products.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('Product', id);
    if (existing.tenantId === null) {
      throw new BusinessException(ErrorCode.FORBIDDEN, 'Cannot delete a global catalog product.');
    }
    await this.products.softDelete(id, byUserId);
    await this.audit.logAction({
      action: 'DELETE',
      resourceType: 'Product',
      resourceId: id,
      userId: byUserId,
      tenantId,
      success: true,
    });
  }

  async search(tenantId: string | null, query: ProductSearchQueryDto): Promise<ProductRow[]> {
    const conditions = [
      isNull(products.deletedAt),
      tenantId
        ? or(eq(products.tenantId, tenantId), isNull(products.tenantId))
        : isNull(products.tenantId),
    ];
    if (query.q) conditions.push(ilike(products.name, `%${query.q}%`));
    if (query.brand) conditions.push(eq(products.brand, query.brand));
    if (query.category) conditions.push(eq(products.categoryId, query.category));
    if (query.status) conditions.push(eq(products.status, query.status));
    const rows = await this.db
      .getDb()
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.createdAt))
      .limit(query.limit);
    return rows as ProductRow[];
  }

  private nutritionToRow(input: NonNullable<CreateProductDto['nutrition']>) {
    const toDecimal = (n?: number) => (n === undefined ? undefined : n.toString());
    return {
      servingSize: toDecimal(input.servingSize),
      servingUnit: input.servingUnit,
      calories: toDecimal(input.calories),
      protein: toDecimal(input.protein),
      carbohydrates: toDecimal(input.carbohydrates),
      sugars: toDecimal(input.sugars),
      fat: toDecimal(input.fat),
      saturatedFat: toDecimal(input.saturatedFat),
      fiber: toDecimal(input.fiber),
      sodium: toDecimal(input.sodium),
      isProcessed: input.isProcessed,
      containsAllergens: input.containsAllergens,
    };
  }
}
