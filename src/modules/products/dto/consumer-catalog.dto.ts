import { z } from 'zod';

/**
 * Consumer Catalog — browse-without-scan surface.
 *
 * Powers the consumer "Browse by category → product list (sorted by health)"
 * flow. Reads the **global catalog** (products with `tenant_id IS NULL`,
 * populated from Open Food Facts) joined to the latest health assessment so the
 * list can show + sort by the health rating, exactly like the discovery flow
 * the product references. Consumer-accessible; never tenant-private rows.
 */

export const CatalogBrowseQuerySchema = z.object({
  /** Filter by a global category id (from `GET /catalog/categories`). */
  category: z.string().uuid().optional(),
  /** Free-text search over product name. */
  q: z.string().min(1).max(100).optional(),
  /** `health` = best-rated first (default); `name` = A→Z. */
  sort: z.enum(['health', 'name']).default('health'),
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type CatalogBrowseQueryDto = z.infer<typeof CatalogBrowseQuerySchema>;

/** One row in a catalog product list. Health fields are null when the product
 *  has no cached assessment yet (designed empty/unknown state on the client —
 *  never a fabricated score). */
export interface CatalogProductItem {
  id: string;
  ean: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  category: string | null;
  healthScore: number | null;
  healthGrade: string | null;
  healthStatus: string | null;
}

/** Cursor-paginated catalog browse response. */
export interface CatalogBrowsePage {
  items: CatalogProductItem[];
  nextCursor: string | null;
}

/** A browsable global category (Top Categories rail). */
export interface CatalogCategory {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
}
