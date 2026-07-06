import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { encodeCursor } from '@/db/repositories/pagination.utils';
import { productHealthAssessments } from '@/db/schema/health-scoring';
import { popularProducts, searchQueries } from '@/db/schema/search';
import { products, type ProductRow } from '@/db/schema/products';

import type { FacetCount, SearchOrderBy } from '../types/search.types';
import { ilikePrefix, ilikeSubstring, sanitiseQuery } from '../utils/search-query.utils';

interface FullTextSearchParams {
  rawQuery: string;
  tenantId: string | null;
  filters: {
    ean?: string;
    brand?: string;
    category?: string;
    healthGrades?: ('A' | 'B' | 'C' | 'D' | 'E')[];
    childSafe?: boolean;
    excludeProcessed?: boolean;
    status?: 'active' | 'discontinued' | 'pending_review' | 'rejected';
  };
  cursor?: string;
  limit: number;
  orderBy: SearchOrderBy;
}

interface FullTextSearchResult {
  data: Array<ProductRow & { rank: number }>;
  total: number;
  nextCursor: string | null;
}

interface AutocompleteSeed {
  id: string;
  name: string;
  brand: string | null;
  matchedField: 'name' | 'brand';
}

/**
 * BE-14 — search-side queries.
 *
 * Reads only — never writes to `products`. Joins to
 * `product_health_assessments` for grade filters and to
 * `popular_products` for the popularity ordering.
 *
 * Tenant precedence: tenant-scoped row > global (`tenant_id IS NULL`),
 * exactly like `ProductsRepository.findVisibleByEan`. The same
 * `tenantId IS NULL OR = $1` clause applies — it's the canonical
 * BE-09 pattern.
 */
@Injectable()
export class SearchRepository {
  constructor(private readonly db: DbService) {}

  /* ─────────────────── Full-text search ─────────────────── */

  async fullTextSearch(params: FullTextSearchParams): Promise<FullTextSearchResult> {
    const db = this.db.getDb();
    const cleaned = sanitiseQuery(params.rawQuery);
    const conditions = this.buildBaseConditions(params.tenantId);

    // text search — combine FTS (`@@ plainto_tsquery`) and trigram
    // fallback (`name ILIKE`/`brand ILIKE`) so single-character typos
    // still surface results.
    if (cleaned.length > 0) {
      const ts = sql`(${products.searchTsv}) @@ plainto_tsquery('english', ${cleaned})`;
      const ilikeName = sql`${products.name} ILIKE ${ilikeSubstring(cleaned)}`;
      const ilikeBrand = sql`${products.brand} ILIKE ${ilikeSubstring(cleaned)}`;
      conditions.push(sql`(${ts} OR ${ilikeName} OR ${ilikeBrand})`);
    }

    if (params.filters.ean) {
      conditions.push(eq(products.ean, params.filters.ean));
    }
    if (params.filters.brand) {
      conditions.push(eq(products.brand, params.filters.brand));
    }
    if (params.filters.category) {
      conditions.push(eq(products.categoryId, params.filters.category));
    }
    if (params.filters.status) {
      conditions.push(eq(products.status, params.filters.status));
    }

    // Optional health-grade / child-safety / processing filters require
    // the join. We add these as extra clauses against the joined table.
    const needHealthJoin =
      (params.filters.healthGrades && params.filters.healthGrades.length > 0) ||
      params.filters.childSafe === true ||
      params.filters.excludeProcessed === true;

    const rankExpr = sql<number>`COALESCE(ts_rank((${products.searchTsv}), plainto_tsquery('english', ${cleaned || ''})), 0)`;

    const orderClause: SQL = ((): SQL => {
      switch (params.orderBy) {
        case 'name':
          return asc(products.name);
        case 'createdAt':
          return desc(products.createdAt);
        case 'popularity':
          return sql`COALESCE((SELECT scan_count + search_count FROM popular_products WHERE popular_products.product_id = products.id LIMIT 1), 0) DESC`;
        case 'relevance':
        default:
          return cleaned.length > 0 ? sql`${rankExpr} DESC` : desc(products.createdAt);
      }
    })();

    let baseSelect: unknown;
    if (needHealthJoin) {
      baseSelect = db
        .select({
          id: products.id,
          createdAt: products.createdAt,
          updatedAt: products.updatedAt,
          deletedAt: products.deletedAt,
          createdBy: products.createdBy,
          updatedBy: products.updatedBy,
          deletedBy: products.deletedBy,
          tenantId: products.tenantId,
          ean: products.ean,
          name: products.name,
          brand: products.brand,
          manufacturer: products.manufacturer,
          categoryId: products.categoryId,
          subCategory: products.subCategory,
          productType: products.productType,
          imageUrl: products.imageUrl,
          description: products.description,
          packageSize: products.packageSize,
          packageUnit: products.packageUnit,
          packageType: products.packageType,
          status: products.status,
          isVerified: products.isVerified,
          dataSource: products.dataSource,
          externalId: products.externalId,
          metadata: products.metadata,
          searchTsv: products.searchTsv,
          rank: rankExpr,
        })
        .from(products)
        .leftJoin(productHealthAssessments, eq(productHealthAssessments.productId, products.id));

      if (params.filters.healthGrades && params.filters.healthGrades.length > 0) {
        conditions.push(
          inArray(productHealthAssessments.overallGrade, params.filters.healthGrades as string[]),
        );
      }
      if (params.filters.childSafe) {
        conditions.push(eq(productHealthAssessments.childSafetyStatus, 'suitable'));
      }
      if (params.filters.excludeProcessed) {
        conditions.push(sql`${productHealthAssessments.isProcessed} != 'ultra'`);
      }
    } else {
      baseSelect = db
        .select({
          id: products.id,
          createdAt: products.createdAt,
          updatedAt: products.updatedAt,
          deletedAt: products.deletedAt,
          createdBy: products.createdBy,
          updatedBy: products.updatedBy,
          deletedBy: products.deletedBy,
          tenantId: products.tenantId,
          ean: products.ean,
          name: products.name,
          brand: products.brand,
          manufacturer: products.manufacturer,
          categoryId: products.categoryId,
          subCategory: products.subCategory,
          productType: products.productType,
          imageUrl: products.imageUrl,
          description: products.description,
          packageSize: products.packageSize,
          packageUnit: products.packageUnit,
          packageType: products.packageType,
          status: products.status,
          isVerified: products.isVerified,
          dataSource: products.dataSource,
          externalId: products.externalId,
          metadata: products.metadata,
          searchTsv: products.searchTsv,
          rank: rankExpr,
        })
        .from(products);
    }

    const rows = (await (
      baseSelect as {
        where: (cond: SQL | undefined) => {
          orderBy: (...args: SQL[]) => { limit: (n: number) => Promise<unknown[]> };
        };
      }
    )
      .where(and(...conditions))
      .orderBy(orderClause, desc(products.createdAt))
      .limit(params.limit + 1)) as Array<ProductRow & { rank: number }>;

    const hasMore = rows.length > params.limit;
    const data = hasMore ? rows.slice(0, -1) : rows;

    // Total count uses the same WHERE clause but skips the rank/order
    // overhead — much faster on large datasets.
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(...conditions));
    const total = Number(countRow?.count ?? 0);

    const nextCursor =
      hasMore && data.length > 0
        ? encodeCursor(data[data.length - 1] as unknown as Record<string, unknown>, [
            { field: 'id', direction: 'desc' },
          ])
        : null;

    return { data, total, nextCursor };
  }

  /* ─────────────────── Autocomplete ─────────────────── */

  async autocomplete(
    rawQuery: string,
    tenantId: string | null,
    limit: number,
  ): Promise<AutocompleteSeed[]> {
    const cleaned = sanitiseQuery(rawQuery);
    if (cleaned.length === 0) return [];
    const db = this.db.getDb();
    const conditions = this.buildBaseConditions(tenantId);
    conditions.push(
      sql`(${products.name} ILIKE ${ilikePrefix(cleaned)} OR ${products.brand} ILIKE ${ilikePrefix(cleaned)})`,
    );

    const rows = (await db
      .select({
        id: products.id,
        name: products.name,
        brand: products.brand,
        nameSim: sql<number>`similarity(${products.name}, ${cleaned})`,
      })
      .from(products)
      .where(and(...conditions))
      .orderBy(sql`similarity(${products.name}, ${cleaned}) DESC`, asc(products.name))
      .limit(limit)) as Array<{ id: string; name: string; brand: string | null; nameSim: number }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      matchedField: r.name.toLowerCase().startsWith(cleaned.toLowerCase()) ? 'name' : 'brand',
    }));
  }

  /* ─────────────────── Facets ─────────────────── */

  async getFacets(tenantId: string | null): Promise<{
    categories: FacetCount[];
    brands: FacetCount[];
    healthGrades: FacetCount[];
    processingLevels: FacetCount[];
  }> {
    const db = this.db.getDb();
    const tenantClause = tenantId
      ? sql`(${products.tenantId} = ${tenantId} OR ${products.tenantId} IS NULL)`
      : sql`${products.tenantId} IS NULL`;

    const [brandRows, gradeRows, processingRows, categoryRows] = await Promise.all([
      db
        .select({ value: products.brand, count: sql<number>`count(*)::int` })
        .from(products)
        .where(and(tenantClause, isNull(products.deletedAt), sql`${products.brand} IS NOT NULL`))
        .groupBy(products.brand)
        .orderBy(desc(sql<number>`count(*)`))
        .limit(20),
      db
        .select({
          value: productHealthAssessments.overallGrade,
          count: sql<number>`count(*)::int`,
        })
        .from(productHealthAssessments)
        .innerJoin(products, eq(products.id, productHealthAssessments.productId))
        .where(and(tenantClause, isNull(products.deletedAt)))
        .groupBy(productHealthAssessments.overallGrade)
        .orderBy(asc(productHealthAssessments.overallGrade)),
      db
        .select({
          value: productHealthAssessments.isProcessed,
          count: sql<number>`count(*)::int`,
        })
        .from(productHealthAssessments)
        .innerJoin(products, eq(products.id, productHealthAssessments.productId))
        .where(and(tenantClause, isNull(products.deletedAt)))
        .groupBy(productHealthAssessments.isProcessed),
      db
        .select({ value: products.categoryId, count: sql<number>`count(*)::int` })
        .from(products)
        .where(
          and(tenantClause, isNull(products.deletedAt), sql`${products.categoryId} IS NOT NULL`),
        )
        .groupBy(products.categoryId)
        .orderBy(desc(sql<number>`count(*)`))
        .limit(20),
    ]);

    return {
      categories: categoryRows.map((r) => ({
        value: r.value ?? '',
        label: r.value ?? '',
        count: Number(r.count),
      })),
      brands: brandRows.map((r) => ({
        value: r.value ?? '',
        label: r.value ?? '',
        count: Number(r.count),
      })),
      healthGrades: gradeRows.map((r) => ({
        value: r.value,
        label: r.value,
        count: Number(r.count),
      })),
      processingLevels: processingRows.map((r) => ({
        value: r.value,
        label: r.value,
        count: Number(r.count),
      })),
    };
  }

  /* ─────────────────── Popular ─────────────────── */

  async getPopular(tenantId: string | null, limit: number): Promise<ProductRow[]> {
    const db = this.db.getDb();
    const tenantClause = tenantId
      ? or(eq(popularProducts.tenantId, tenantId), isNull(popularProducts.tenantId))
      : isNull(popularProducts.tenantId);

    const rows = (await db
      .select({ products })
      .from(popularProducts)
      .innerJoin(products, eq(products.id, popularProducts.productId))
      .where(and(tenantClause!, isNull(products.deletedAt)))
      .orderBy(
        desc(popularProducts.scanCount),
        desc(popularProducts.searchCount),
        desc(popularProducts.lastSeenAt),
      )
      .limit(limit)) as Array<{ products: ProductRow }>;
    return rows.map((r) => r.products);
  }

  async findSimilar(
    productId: string,
    tenantId: string | null,
    limit: number,
  ): Promise<ProductRow[]> {
    const db = this.db.getDb();
    const tenantClause = tenantId
      ? or(eq(products.tenantId, tenantId), isNull(products.tenantId))
      : isNull(products.tenantId);

    const [origin] = await db
      .select({
        id: products.id,
        name: products.name,
        brand: products.brand,
        categoryId: products.categoryId,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (!origin) return [];

    const rows = (await db
      .select({ products })
      .from(products)
      .where(
        and(
          tenantClause!,
          isNull(products.deletedAt),
          sql`${products.id} <> ${productId}`,
          sql`(similarity(${products.name}, ${origin.name}) > 0.3 OR ${products.brand} = ${origin.brand} OR ${products.categoryId} = ${origin.categoryId})`,
        ),
      )
      .orderBy(sql`similarity(${products.name}, ${origin.name}) DESC`)
      .limit(limit)) as Array<{ products: ProductRow }>;
    return rows.map((r) => r.products);
  }

  /* ─────────────────── Analytics ─────────────────── */

  async logSearch(event: {
    tenantId: string | null;
    userId?: string | null;
    queryText: string;
    resultCount: number;
    durationMs: number;
    source?: 'search' | 'autocomplete';
  }): Promise<void> {
    const db = this.db.getDb();
    await db.insert(searchQueries).values({
      tenantId: event.tenantId,
      userId: event.userId ?? null,
      queryText: event.queryText.slice(0, 200),
      resultCount: event.resultCount,
      durationMs: event.durationMs,
      hasResults: event.resultCount > 0,
      source: event.source ?? 'search',
    });
  }

  async incrementPopularity(
    productId: string,
    tenantId: string | null,
    delta: { scans?: number; searches?: number } = {},
  ): Promise<void> {
    const db = this.db.getDb();
    const scansDelta = delta.scans ?? 0;
    const searchesDelta = delta.searches ?? 0;

    await db
      .insert(popularProducts)
      .values({
        productId,
        tenantId,
        scanCount: scansDelta,
        searchCount: searchesDelta,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [popularProducts.tenantId, popularProducts.productId],
        set: {
          scanCount: sql`${popularProducts.scanCount} + ${scansDelta}`,
          searchCount: sql`${popularProducts.searchCount} + ${searchesDelta}`,
          lastSeenAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
  }

  /* ─────────────────── Internals ─────────────────── */

  private buildBaseConditions(tenantId: string | null): SQL[] {
    const out: SQL[] = [isNull(products.deletedAt)];
    out.push(
      tenantId
        ? sql`(${products.tenantId} = ${tenantId} OR ${products.tenantId} IS NULL)`
        : isNull(products.tenantId),
    );
    return out;
  }
}
