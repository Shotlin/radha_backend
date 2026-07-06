/**
 * Canonical RADHA consumer-catalog categories.
 *
 * The `slug` values are the contract between three layers:
 *   - the seeded `product_categories` rows (this importer ensures them),
 *   - `GET /catalog/categories` (consumer Top Categories rail),
 *   - the Flutter category tile assets the user supplies:
 *       biscuits-snacks   → cat-biscuits.png
 *       breakfast-spreads → cat-breakfast.png
 *       dairy-eggs        → cat-dairy.png
 *       beverages         → cat-beverages.png
 *       staples-grains    → cat-staples.png
 *       frozen            → cat-frozen.png
 *       personal-care     → cat-personal-care.png
 *       household         → cat-household.png
 *
 * `offCategoryTags` are the Open Food Facts category tags pulled during import.
 * Open Food Facts is **food-only**, so `personal-care` and `household` have no
 * OFF source (empty tags) — they are seeded as categories but populate from a
 * different source later. The browse surface shows a designed empty state for
 * them in the meantime (never fabricated rows).
 */
export interface CatalogCategoryConfig {
  slug: string;
  name: string;
  sortOrder: number;
  /** OFF category tags to import from. Empty = not available in OFF (food-only). */
  offCategoryTags: string[];
}

export const CATALOG_CATEGORIES: readonly CatalogCategoryConfig[] = [
  {
    slug: 'biscuits-snacks',
    name: 'Biscuits & Snacks',
    sortOrder: 0,
    offCategoryTags: ['biscuits', 'snacks'],
  },
  {
    slug: 'breakfast-spreads',
    name: 'Breakfast & Spreads',
    sortOrder: 1,
    offCategoryTags: ['breakfast-cereals', 'spreads'],
  },
  {
    slug: 'dairy-eggs',
    name: 'Dairy & Eggs',
    sortOrder: 2,
    offCategoryTags: ['dairies'],
  },
  {
    slug: 'beverages',
    name: 'Beverages',
    sortOrder: 3,
    offCategoryTags: ['beverages'],
  },
  {
    slug: 'staples-grains',
    name: 'Staples & Grains',
    sortOrder: 4,
    offCategoryTags: ['cereals-and-potatoes', 'legumes'],
  },
  {
    slug: 'frozen',
    name: 'Frozen',
    sortOrder: 5,
    offCategoryTags: ['frozen-foods'],
  },
  {
    slug: 'personal-care',
    name: 'Personal Care',
    sortOrder: 6,
    offCategoryTags: [],
  },
  {
    slug: 'household',
    name: 'Household',
    sortOrder: 7,
    offCategoryTags: [],
  },
] as const;
