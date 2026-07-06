import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewProductNutrition, ProductNutritionRow, productNutrition } from '@/db/schema/products';

@Injectable()
export class ProductNutritionRepository extends BaseRepository<
  typeof productNutrition,
  ProductNutritionRow,
  NewProductNutrition,
  Partial<NewProductNutrition>
> {
  constructor(db: DbService) {
    super(db.getDb(), productNutrition, 'product_nutrition');
  }

  async findByProductId(productId: string): Promise<ProductNutritionRow | null> {
    const [row] = await this.db
      .select()
      .from(productNutrition)
      .where(eq(productNutrition.productId, productId))
      .limit(1);
    return (row as ProductNutritionRow | undefined) ?? null;
  }

  async upsertForProduct(
    productId: string,
    data: Partial<NewProductNutrition>,
  ): Promise<ProductNutritionRow> {
    const existing = await this.findByProductId(productId);
    if (existing) {
      const [updated] = await this.db
        .update(productNutrition)
        .set(data)
        .where(eq(productNutrition.productId, productId))
        .returning();
      return updated as ProductNutritionRow;
    }
    return this.create({ ...data, productId } as NewProductNutrition);
  }
}
