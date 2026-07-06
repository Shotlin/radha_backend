import { z } from 'zod';

/**
 * BE-51 — Public Product Profile Pages (SEO).
 *
 * Query schema and response interfaces for the
 * `/api/v1/public/products/*` endpoints consumed by the Next.js
 * marketing site at static-build time.
 *
 * The response shape is **deliberately a subset** of the underlying
 * `products` row. Anything that could leak tenant data (tenant_id,
 * created_by, store_id, internal flags, …) is filtered out by
 * `PublicProductService.toPublicView()` — see the column allow-list
 * test in `__tests__/public-product.service.spec.ts`.
 */

/** `GET /api/v1/public/products/:slug` query string. */
export const PublicProductQuerySchema = z
  .object({
    /**
     * Optional language hint that the marketing site forwards from
     * its Accept-Language detection. Today only English content is
     * shipped; the field is reserved for BE-42 hreflang work.
     */
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
  })
  .strict();

export type PublicProductQueryDto = z.infer<typeof PublicProductQuerySchema>;

/**
 * `GET /api/v1/public/products/sitemap.xml` query string.
 *
 * Sitemap pagination is cursor-based on `(updated_at desc, id desc)`
 * because Google asks for sitemap files no larger than 50K URLs /
 * 50 MB each. `cursor` is opaque; clients only ever pass back what
 * the previous page returned in `nextCursor`.
 */
export const SitemapQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z
      .union([z.number().int(), z.string().regex(/^\d+$/)])
      .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
      .pipe(z.number().int().min(1).max(50_000))
      .optional(),
  })
  .strict();

export type SitemapQueryDto = z.infer<typeof SitemapQuerySchema>;

/**
 * Public-facing view of a product.
 *
 * Allow-list columns ONLY. Adding a field here without updating the
 * column allow-list test in `public-product.service.spec.ts` will
 * fail CI.
 */
export interface PublicProductView {
  ean: string;
  name: string;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  ingredientsText: string | null;
  /** Free-form list of declared allergens (post-OFF normalisation). */
  allergens: string[];
  publicSlug: string;
  /** A | B | C | D | E | U — populated from BE-12 health assessment. */
  healthLabel: string | null;
  /** 0..100 numeric score from BE-12 (null when no assessment yet). */
  healthScore: number | null;
  /** ISO timestamp of the most recent BE-12 scoring run. */
  computedAt: string | null;
}

/**
 * One `<url>` entry in the sitemap.
 *
 * The Next.js layer formats these into XML; the API stays JSON so
 * the surface is testable without mocking XML parsers.
 */
export interface SitemapEntry {
  /** Slug only — the marketing site joins it to its base URL. */
  slug: string;
  /** ISO timestamp; rendered as `<lastmod>` in the XML. */
  updatedAt: string;
}

export interface SitemapPage {
  entries: SitemapEntry[];
  /** Pass back as `cursor` for the next page; `null` when caught up. */
  nextCursor: string | null;
}
