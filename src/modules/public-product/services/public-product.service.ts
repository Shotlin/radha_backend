import { GoneException, Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { products, type ProductRow } from '@/db/schema/products';
import { LoggerService } from '@/logging/logger.service';
import { HealthAssessmentsRepository } from '@/modules/health-scoring/repositories/health-assessments.repository';

import {
  type PublicProductView,
  type SitemapEntry,
  type SitemapPage,
} from '../dto/public-product.dto';

/**
 * BE-51 — Public-facing product profile read-side.
 *
 * Powers the Next.js marketing page builder: at static-generation
 * time the marketing site fetches one product per page and the full
 * sitemap once. Both endpoints are public (no JWT, no tenant
 * scope) so the service is hyper-careful about what it returns:
 *
 *   1. Tenant-scoped rows are filtered out with `tenant_id IS NULL`.
 *   2. The response is built by `toPublicView()`, which projects ONLY
 *      the allow-listed columns. Everything else (tenant_id,
 *      created_by, metadata, internal flags, …) is dropped.
 *   3. `withdrawn` and `unsafe` products throw `GoneException`,
 *      which the global filter renders as HTTP 410 with an empty
 *      body — search engines deindex 410-responding URLs faster than
 *      404s, so this is the right signal for product withdrawal.
 *
 * The health-assessment join is best-effort: if BE-12 hasn't scored
 * the product yet, the page still renders with `healthLabel: null`
 * and the marketing site shows a "score pending" placeholder.
 */

/**
 * Allow-list of columns that may appear in the public response.
 * Kept as a const tuple so the test in
 * `public-product.service.spec.ts` can assert the exact shape.
 */
export const PUBLIC_PRODUCT_ALLOWLIST = [
  'ean',
  'name',
  'brand',
  'category',
  'imageUrl',
  'ingredientsText',
  'allergens',
  'publicSlug',
  'healthLabel',
  'healthScore',
  'computedAt',
] as const satisfies ReadonlyArray<keyof PublicProductView>;

@Injectable()
export class PublicProductService {
  constructor(
    private readonly db: DbService,
    private readonly logger: LoggerService,
    @Optional()
    @Inject(HealthAssessmentsRepository)
    private readonly healthAssessments: HealthAssessmentsRepository | null,
  ) {}

  /**
   * Find a product by its public slug.
   *
   * Returns:
   *   - `null` when no product carries that slug → controller maps
   *     to HTTP 404,
   *   - throws `GoneException` for `withdrawn`/`unsafe` rows → 410,
   *   - the projected `PublicProductView` for `active` rows.
   *
   * Tenant-scoped rows are excluded by the `tenant_id IS NULL` clause
   * even though the unique constraint on `public_slug` already makes
   * collisions impossible — defense in depth so a bug in slug
   * generation can't accidentally expose private data.
   */
  async findBySlug(slug: string): Promise<PublicProductView | null> {
    const db = this.db.getDb();
    const [row] = await db
      .select()
      .from(products)
      .where(
        and(
          eq(products.publicSlug, slug),
          isNull(products.tenantId),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return null;

    const product = row as ProductRow;
    if (product.publicStatus === 'withdrawn' || product.publicStatus === 'unsafe') {
      this.logger.info('public-product.gone', {
        slug,
        status: product.publicStatus,
      });
      throw new GoneException();
    }

    return this.toPublicView(product);
  }

  /**
   * Build a sitemap page.
   *
   * Cursor format is `<isoUpdatedAt>|<id>` — opaque to clients but
   * trivially decodable so we don't need a separate cursor table.
   * Sort is `(updated_at desc, id desc)` so a steady stream of
   * crawler hits sees the freshest URLs first.
   *
   * `limit` is clamped at 50 000 by the schema (Google's hard cap).
   * Callers requesting nothing get the maximum.
   */
  async listSitemap(options: { cursor?: string; limit?: number }): Promise<SitemapPage> {
    const limit = Math.min(Math.max(options.limit ?? 50_000, 1), 50_000);
    const db = this.db.getDb();

    const conditions = [
      isNotNull(products.publicSlug),
      eq(products.publicStatus, 'active'),
      isNull(products.tenantId),
      isNull(products.deletedAt),
    ];

    if (options.cursor) {
      const decoded = decodeSitemapCursor(options.cursor);
      if (decoded) {
        // (updated_at, id) < (cursor.updated_at, cursor.id) using a
        // tuple comparison keeps the order stable across pages.
        conditions.push(
          or(
            lt(products.updatedAt, decoded.updatedAt),
            and(eq(products.updatedAt, decoded.updatedAt), lt(products.id, decoded.id)),
          )!,
        );
      }
    }

    const rows = await db
      .select({
        id: products.id,
        publicSlug: products.publicSlug,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.updatedAt), desc(products.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const entries: SitemapEntry[] = sliced
      .filter((r): r is typeof r & { publicSlug: string } => r.publicSlug !== null)
      .map((r) => ({
        slug: r.publicSlug,
        updatedAt: r.updatedAt.toISOString(),
      }));

    const nextCursor = hasMore && sliced.length > 0
      ? encodeSitemapCursor({
          updatedAt: sliced[sliced.length - 1].updatedAt,
          id: sliced[sliced.length - 1].id,
        })
      : null;

    return { entries, nextCursor };
  }

  /**
   * Project a `ProductRow` plus its (optional) health assessment
   * onto the public allow-list. Anything not in the allow-list is
   * dropped — the test in `public-product.service.spec.ts` asserts
   * this contract by snapshotting the response key set.
   */
  private async toPublicView(product: ProductRow): Promise<PublicProductView> {
    let healthLabel: string | null = null;
    let healthScore: number | null = null;
    let computedAt: string | null = null;

    if (this.healthAssessments) {
      try {
        const assessment = await this.healthAssessments.findLatestForProduct(product.id);
        if (assessment) {
          healthLabel = assessment.overallGrade;
          healthScore = assessment.overallScore;
          computedAt = assessment.computedAt.toISOString();
        }
      } catch (err) {
        // Health scoring failures must NEVER take down the public
        // page — log and degrade to a "score pending" view.
        this.logger.warn('public-product.health-assessment.failed', {
          productId: product.id,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }

    const allergens = extractAllergens(product);
    const ingredientsText = extractIngredientsText(product);
    const category = extractCategory(product);

    return {
      ean: product.ean,
      name: product.name,
      brand: product.brand ?? null,
      category,
      imageUrl: product.imageUrl ?? null,
      ingredientsText,
      allergens,
      publicSlug: product.publicSlug ?? '',
      healthLabel,
      healthScore,
      computedAt,
    };
  }
}

/**
 * Pull a normalised allergen list out of the product row.
 *
 * OFF-sourced rows store allergen tags in `metadata.allergens` as a
 * comma-separated string (e.g. "en:milk,en:nuts") or as a string[]
 * after BE-11 normalisation. We accept both shapes and dedupe.
 */
function extractAllergens(product: ProductRow): string[] {
  const meta = (product.metadata ?? {}) as Record<string, unknown>;
  const raw = meta['allergens'];
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.filter((v): v is string => typeof v === 'string')));
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return Array.from(
      new Set(
        raw
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    );
  }
  return [];
}

/**
 * Look up the human-readable ingredients text. OFF rows park this
 * in `metadata.ingredients_text`; manually-entered rows put it in
 * `description`.
 */
function extractIngredientsText(product: ProductRow): string | null {
  const meta = (product.metadata ?? {}) as Record<string, unknown>;
  const candidate =
    (meta['ingredients_text'] as string | undefined) ??
    (meta['ingredientsText'] as string | undefined) ??
    product.description;
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Best-effort category label. The schema only carries a category
 * UUID; the human-readable name lives in `product_categories` and
 * we'd need a join to fetch it. For BE-51 we surface
 * `metadata.category_label` if OFF supplied one and fall back to
 * `subCategory` so the page is never blank.
 */
function extractCategory(product: ProductRow): string | null {
  const meta = (product.metadata ?? {}) as Record<string, unknown>;
  const label = meta['category_label'] ?? meta['categoryLabel'];
  if (typeof label === 'string' && label.trim().length > 0) return label.trim();
  if (product.subCategory && product.subCategory.trim().length > 0) return product.subCategory;
  return null;
}

interface SitemapCursor {
  updatedAt: Date;
  id: string;
}

function encodeSitemapCursor(cursor: SitemapCursor): string {
  const raw = `${cursor.updatedAt.toISOString()}|${cursor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeSitemapCursor(cursor: string): SitemapCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep <= 0) return null;
    const updatedAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(updatedAt.getTime()) || id.length === 0) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
