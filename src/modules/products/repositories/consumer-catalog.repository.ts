import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { productHealthAssessments } from '@/db/schema/health-scoring';
import { productCategories, products } from '@/db/schema/products';
import { RULE_VERSION_V1 } from '@/modules/health-scoring/rules/v1-rules';

import type {
  CatalogBrowseQueryDto,
  CatalogCategory,
  CatalogProductItem,
} from '../dto/consumer-catalog.dto';

/**
 * Consumer Catalog repository.
 *
 * Owns the two read queries behind the browse-without-scan flow:
 *   - {@link listCategories} — global categories for the Top Categories rail.
 *   - {@link browse} — global-catalog products LEFT JOINed to the latest health
 *     assessment, filterable by category/text, sorted by health rating or name,
 *     with keyset pagination (no unbounded SELECTs).
 *
 * All reads are restricted to the **global catalog** (`tenant_id IS NULL`,
 * `status = 'active'`, not soft-deleted). Tenant-private rows are never exposed
 * through this consumer surface.
 *
 * The health LEFT JOIN is keyed on {@link RULE_VERSION_V1}. When a v2 ruleset
 * ships, update this constant alongside the scoring engine's current version.
 */
@Injectable()
export class ConsumerCatalogRepository {
  constructor(private readonly db: DbService) {}

  /** Encode a keyset cursor as URL-safe base64 JSON. */
  private static encodeCursor(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /** Decode a keyset cursor; returns null on any malformed input. */
  private static decodeCursor(raw: string): Record<string, unknown> | null {
    try {
      const json = Buffer.from(raw, 'base64url').toString('utf8');
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async listCategories(): Promise<CatalogCategory[]> {
    const rows = await this.db
      .getDb()
      .select({
        id: productCategories.id,
        name: productCategories.name,
        slug: productCategories.slug,
        sortOrder: productCategories.sortOrder,
      })
      .from(productCategories)
      .where(isNull(productCategories.tenantId))
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.name));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      // `sort_order` is stored as a varchar; coerce to a number for the client.
      sortOrder: Number.parseInt(r.sortOrder, 10) || 0,
    }));
  }

  async browse(
    query: CatalogBrowseQueryDto,
  ): Promise<{ items: CatalogProductItem[]; nextCursor: string | null }> {
    // `coalesce(score, -1)` sinks unscored products below every scored one so
    // the "best rated first" ordering is stable and unscored rows never jump
    // ahead of a real grade.
    const scoreExpr = sql<number>`coalesce(${productHealthAssessments.overallScore}, -1)`;

    const conditions = [
      isNull(products.tenantId),
      isNull(products.deletedAt),
      eq(products.status, 'active'),
    ];
    if (query.category) conditions.push(eq(products.categoryId, query.category));
    if (query.q) conditions.push(ilike(products.name, `%${query.q}%`));

    const cursor = query.cursor ? ConsumerCatalogRepository.decodeCursor(query.cursor) : null;

    if (query.sort === 'name') {
      if (cursor && typeof cursor.name === 'string' && typeof cursor.id === 'string') {
        conditions.push(
          sql`(${products.name} > ${cursor.name}) OR (${products.name} = ${cursor.name} AND ${products.id} > ${cursor.id})`,
        );
      }
    } else {
      // health sort
      if (cursor && typeof cursor.score === 'number' && typeof cursor.id === 'string') {
        conditions.push(
          sql`(${scoreExpr} < ${cursor.score}) OR (${scoreExpr} = ${cursor.score} AND ${products.id} > ${cursor.id})`,
        );
      }
    }

    const baseQuery = this.db
      .getDb()
      .select({
        id: products.id,
        ean: products.ean,
        name: products.name,
        brand: products.brand,
        imageUrl: products.imageUrl,
        subCategory: products.subCategory,
        healthScore: productHealthAssessments.overallScore,
        healthGrade: productHealthAssessments.overallGrade,
        healthStatus: productHealthAssessments.healthStatus,
      })
      .from(products)
      .leftJoin(
        productHealthAssessments,
        and(
          eq(productHealthAssessments.productId, products.id),
          eq(productHealthAssessments.ruleVersion, RULE_VERSION_V1),
        ),
      )
      .where(and(...conditions));

    const ordered =
      query.sort === 'name'
        ? baseQuery.orderBy(asc(products.name), asc(products.id))
        : baseQuery.orderBy(sql`${scoreExpr} desc`, asc(products.id));

    const rows = await ordered.limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const items: CatalogProductItem[] = page.map((r) => ({
      id: r.id,
      ean: r.ean,
      name: r.name,
      brand: r.brand,
      imageUrl: r.imageUrl,
      category: r.subCategory,
      healthScore: r.healthScore,
      healthGrade: r.healthGrade,
      healthStatus: r.healthStatus,
    }));

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor =
        query.sort === 'name'
          ? ConsumerCatalogRepository.encodeCursor({ name: last.name, id: last.id })
          : ConsumerCatalogRepository.encodeCursor({
              score: last.healthScore ?? -1,
              id: last.id,
            });
    }

    return { items, nextCursor };
  }
}
