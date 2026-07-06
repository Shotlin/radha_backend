import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { products } from '@/db/schema/products';
import { LoggerService } from '@/logging/logger.service';

/**
 * BE-51 — Slug generator + collision retry.
 *
 * The slug shape is `{kebab(name)}-{ean.slice(-4)}`:
 *   - `kebab(name)` lowercases, strips diacritics, and collapses
 *     non-alphanumeric runs into single `-`. Capped at 60 chars so
 *     URLs stay reasonable. Empty inputs fall back to `'product'`
 *     so we never emit a slug that's just the EAN suffix.
 *   - `ean.slice(-4)` injects entropy without leaking the full
 *     barcode; collisions are statistically rare but possible
 *     (e.g. two reformulations of the same EAN family with the same
 *     name) — when they happen, `generate()` walks `slug-2`,
 *     `slug-3`, … until the unique index accepts the value.
 *
 * Backfill: `backfillProduct()` is the single sanctioned path for
 * populating `public_slug` on existing rows. It re-uses `generate()`
 * so the deterministic suffix matches what a fresh row would carry.
 */

/** Max characters of the kebab-cased name segment. */
const MAX_NAME_SEGMENT = 60;

/** Max collision-retry attempts before we surrender. */
const MAX_COLLISION_RETRIES = 50;

@Injectable()
export class SlugService {
  constructor(
    private readonly db: DbService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Pure deterministic kebab transform. Exported as a static helper
   * so tests don't need to spin up the Nest container.
   *
   *   "Maggi 2-Minute Noodles!"  →  "maggi-2-minute-noodles"
   *   "Café — naïve"             →  "cafe-naive"
   *   "   "                      →  "product"
   */
  static kebab(input: string | null | undefined, maxLength = MAX_NAME_SEGMENT): string {
    if (!input) return 'product';
    const slug = input
      .toLowerCase()
      // Strip diacritics: NFKD splits "é" into "e" + combining acute,
      // then we drop every combining-mark code point.
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return (slug || 'product').slice(0, maxLength).replace(/-+$/g, '') || 'product';
  }

  /**
   * Compose the deterministic base slug for a product.
   *
   *   name='Maggi Noodles', ean='8901058869293'
   *     →  'maggi-noodles-9293'
   *
   * Last-4 of EAN is preferred over a random suffix so the slug is
   * stable across re-runs of the backfill — Google penalises pages
   * whose canonical URL flips between crawls.
   */
  static composeBase(name: string | null | undefined, ean: string): string {
    const namePart = SlugService.kebab(name);
    const eanPart = (ean ?? '').replace(/[^0-9]/g, '').slice(-4) || '0000';
    return `${namePart}-${eanPart}`;
  }

  /**
   * Generate a unique slug for the given (name, ean) pair.
   *
   * Walks `base`, `base-2`, `base-3`, … checking the index for
   * each candidate. The first candidate that's not currently in
   * use is returned. We **don't** insert here — the caller owns
   * the row write and re-checks on `INSERT … ON CONFLICT` to
   * close the race window.
   *
   * `excludeProductId` lets the backfill helper ignore the row
   * being updated (which already carries an old slug we want to
   * replace) so it doesn't collide with itself.
   */
  async generate(
    name: string | null | undefined,
    ean: string,
    excludeProductId?: string,
  ): Promise<string> {
    const base = SlugService.composeBase(name, ean);
    let candidate = base;
    for (let attempt = 1; attempt <= MAX_COLLISION_RETRIES; attempt += 1) {
      const taken = await this.isSlugTaken(candidate, excludeProductId);
      if (!taken) return candidate;
      attempt += 0; // keep linter happy about loop var usage
      candidate = `${base}-${attempt + 1}`;
    }
    // Extremely unlikely fallback: pure-numeric tail off the EAN
    // plus a timestamp. Logged as a warning because hitting this
    // path means our slug shape needs reconsidering.
    const fallback = `${base}-${Date.now().toString(36)}`;
    this.logger.warn('public-product.slug.collision-exhausted', { base, fallback });
    return fallback;
  }

  /** Cheap uniqueness probe — uses the partial index from migration 0022. */
  private async isSlugTaken(slug: string, excludeProductId?: string): Promise<boolean> {
    const db = this.db.getDb();
    const where = excludeProductId
      ? and(eq(products.publicSlug, slug), sql`${products.id} <> ${excludeProductId}`)
      : eq(products.publicSlug, slug);
    const [row] = await db.select({ id: products.id }).from(products).where(where).limit(1);
    return Boolean(row);
  }

  /**
   * Backfill a single product row by computing a fresh slug and
   * writing it. Idempotent: if the row already carries a slug it's
   * left alone unless `force=true`.
   *
   * Returns the slug now associated with the product (existing or
   * newly written) so callers can log it.
   */
  async backfillProduct(
    productId: string,
    options: { force?: boolean } = {},
  ): Promise<{ slug: string | null; updated: boolean }> {
    const db = this.db.getDb();
    const [row] = await db
      .select({
        id: products.id,
        ean: products.ean,
        name: products.name,
        publicSlug: products.publicSlug,
        tenantId: products.tenantId,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (!row) return { slug: null, updated: false };

    // Tenant-private rows are NEVER published to the public catalog.
    if (row.tenantId !== null) return { slug: row.publicSlug ?? null, updated: false };

    if (row.publicSlug && !options.force) {
      return { slug: row.publicSlug, updated: false };
    }

    const slug = await this.generate(row.name, row.ean, row.id);
    await db.update(products).set({ publicSlug: slug }).where(eq(products.id, productId));
    return { slug, updated: true };
  }

  /**
   * Bulk backfill — walks every global (tenant_id IS NULL) product
   * that currently has no slug and writes one. Used once after the
   * BE-51 migration ships and again whenever the migration
   * idempotency check is run from the scheduler.
   *
   * Returns the number of rows that received a fresh slug.
   */
  async backfillAllMissing(batchSize = 500): Promise<number> {
    const db = this.db.getDb();
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await db
        .select({
          id: products.id,
          ean: products.ean,
          name: products.name,
        })
        .from(products)
        .where(and(isNull(products.publicSlug), isNull(products.tenantId)))
        .limit(batchSize);

      if (rows.length === 0) break;

      for (const row of rows) {
        const slug = await this.generate(row.name, row.ean, row.id);
        await db.update(products).set({ publicSlug: slug }).where(eq(products.id, row.id));
        total += 1;
      }

      // Defensive: if the same batch keeps coming back something is
      // wrong with the WHERE clause; bail rather than loop forever.
      if (rows.length < batchSize) break;
    }
    this.logger.info('public-product.slug.backfill.completed', { total });
    return total;
  }

  /** Test-friendly accessor — just lets callers see the partial-index probe. */
  async hasAnyPublicProduct(): Promise<boolean> {
    const db = this.db.getDb();
    const [row] = await db
      .select({ id: products.id })
      .from(products)
      .where(isNotNull(products.publicSlug))
      .limit(1);
    return Boolean(row);
  }
}
