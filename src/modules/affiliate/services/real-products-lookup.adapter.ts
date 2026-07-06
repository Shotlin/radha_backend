import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { productHealthAssessments } from '@/db/schema/health-scoring';
import { RULE_VERSION_V1 } from '@/modules/health-scoring/rules/v1-rules';
import { ProductsRepository } from '@/modules/products/products.repository';
import { ConsumerCatalogRepository } from '@/modules/products/repositories/consumer-catalog.repository';

import type { FindHealthierOptions, ProductCatalogEntry, ProductsLookupPort } from '../types/affiliate.types';

@Injectable()
export class RealProductsLookupAdapterService implements ProductsLookupPort {
  constructor(
    private readonly productsRepo: ProductsRepository,
    private readonly catalogRepo: ConsumerCatalogRepository,
    private readonly db: DbService,
  ) {}

  async findByEan(ean: string): Promise<ProductCatalogEntry | null> {
    const row = await this.productsRepo.findVisibleByEan(ean, null);
    if (!row) return null;

    const [assessment] = await this.db
      .getDb()
      .select({ overallScore: productHealthAssessments.overallScore })
      .from(productHealthAssessments)
      .where(
        and(
          eq(productHealthAssessments.productId, row.id),
          eq(productHealthAssessments.ruleVersion, RULE_VERSION_V1),
        ),
      )
      .limit(1);

    return {
      ean: row.ean,
      name: row.name,
      brand: row.brand ?? null,
      categoryId: row.categoryId ?? null,
      healthScore: assessment?.overallScore ?? 0,
    };
  }

  async findHealthierThan(
    sourceEan: string,
    options: FindHealthierOptions = {},
  ): Promise<ProductCatalogEntry[]> {
    const limit = options.limit ?? 5;
    const minDelta = options.minDelta ?? 0;

    const source = await this.findByEan(sourceEan);
    if (!source) return [];

    const categoryId = source.categoryId;
    if (!categoryId) return [];

    const { items } = await this.catalogRepo.browse({
      category: categoryId,
      sort: 'health',
      limit: 50,
    });

    return items
      .filter((item) => item.ean !== sourceEan)
      .filter((item) => (item.healthScore ?? 0) >= source.healthScore + minDelta)
      .slice(0, limit)
      .map((item) => ({
        ean: item.ean,
        name: item.name,
        brand: item.brand ?? null,
        categoryId,
        healthScore: item.healthScore ?? 0,
      }));
  }
}
