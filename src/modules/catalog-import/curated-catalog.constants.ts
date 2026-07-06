/**
 * Curated launch-catalog seed manifest — the backend mirror of the Flutter
 * `apps/mobile/lib/features/catalog/data/launch_catalog.dart` spine.
 *
 * These 29 hand-picked, recognisable Indian retail products give the consumer
 * "Shop by category → product" browse flow real, premium content on day one,
 * independent of the broad Open Food Facts bulk import (`CATALOG_CATEGORIES`).
 *
 * Honesty contract (matches the mobile manifest + the health-brand guardrail):
 *   - We carry **identity only** here: slug, display name, brand, pack size,
 *     target category slug, OFF text-search terms, and veg flag.
 *   - We **never** hard-code an EAN/barcode. The curated importer resolves the
 *     real market barcode by OFF free-text search (brand + name) at seed time;
 *     if OFF can't confidently resolve one, the product is skipped (logged),
 *     never seeded with a fabricated code.
 *   - Nutrition/health are never invented — they come from the resolved OFF
 *     row through the same mapper + scorer as the bulk import, or stay absent
 *     (the mobile detail screen shows an honest "scan to unlock" state).
 *
 * `slug` is the join key back to the bundled WebP pack-shot the app ships
 * (`assets/v2/products/<slug>.webp`) and to the mobile manifest entry.
 * `categorySlug` must be one of the `CATALOG_CATEGORIES` slugs.
 */
export interface CuratedProductSeed {
  /** Stable kebab-case id; matches the mobile manifest slug + asset stem. */
  slug: string;
  /** Display name used as the OFF search query and the fallback product name. */
  name: string;
  /** Brand line; prepended to the OFF search query to disambiguate. */
  brand?: string;
  /** Pack size shown in the app (informational; not used for matching). */
  netWeight?: string;
  /** Target catalog category slug (one of CATALOG_CATEGORIES). */
  categorySlug: string;
  /**
   * Free-text query handed to OFF to resolve the real barcode. Defaults to
   * `${brand} ${name}` when omitted; override when the market name differs
   * from the display name.
   */
  searchTerms?: string;
  /** Veg/non-veg hint for the mobile filter; not persisted by the seed. */
  isVeg?: boolean;
}

export const CURATED_CATALOG: readonly CuratedProductSeed[] = [
  // ── Biscuits & Snacks ───────────────────────────────────────────────────
  {
    slug: 'parle-g-biscuits',
    name: 'Parle-G Glucose Biscuits',
    brand: 'Parle',
    netWeight: '250 g',
    categorySlug: 'biscuits-snacks',
    isVeg: true,
  },
  {
    slug: 'lays-classic-salted',
    name: "Lay's Classic Salted",
    brand: "Lay's",
    netWeight: '90 g',
    categorySlug: 'biscuits-snacks',
    isVeg: true,
  },
  {
    slug: 'haldiram-aloo-bhujia',
    name: "Haldiram's Aloo Bhujia",
    brand: "Haldiram's",
    netWeight: '200 g',
    categorySlug: 'biscuits-snacks',
    isVeg: true,
  },

  // ── Breakfast & Spreads ─────────────────────────────────────────────────
  {
    slug: 'cerelac',
    name: 'Cerelac Baby Cereal',
    brand: 'Nestlé',
    netWeight: '300 g',
    categorySlug: 'breakfast-spreads',
    isVeg: true,
  },
  {
    slug: 'britannia-white-bread',
    name: 'Britannia White Bread',
    brand: 'Britannia',
    netWeight: '400 g',
    categorySlug: 'breakfast-spreads',
    isVeg: true,
  },
  {
    slug: 'multigrain-bread',
    name: 'Multigrain Bread',
    netWeight: '400 g',
    categorySlug: 'breakfast-spreads',
    isVeg: true,
  },

  // ── Dairy & Eggs ────────────────────────────────────────────────────────
  {
    slug: 'amul-butter',
    name: 'Amul Butter',
    brand: 'Amul',
    netWeight: '100 g',
    categorySlug: 'dairy-eggs',
    isVeg: true,
  },
  {
    slug: 'amul-ghee',
    name: 'Amul Pure Ghee',
    brand: 'Amul',
    netWeight: '500 ml',
    categorySlug: 'dairy-eggs',
    isVeg: true,
  },
  {
    slug: 'amul-toned-milk',
    name: 'Amul Toned Milk',
    brand: 'Amul',
    netWeight: '500 ml',
    categorySlug: 'dairy-eggs',
    isVeg: true,
  },
  { slug: 'paneer', name: 'Paneer', netWeight: '200 g', categorySlug: 'dairy-eggs', isVeg: true },
  {
    slug: 'farm-eggs',
    name: 'Eggs',
    netWeight: '6 pack',
    categorySlug: 'dairy-eggs',
    isVeg: false,
  },

  // ── Beverages ───────────────────────────────────────────────────────────
  {
    slug: 'coca-cola',
    name: 'Coca-Cola',
    brand: 'Coca-Cola',
    netWeight: '750 ml',
    categorySlug: 'beverages',
    isVeg: true,
  },
  {
    slug: 'real-mango-juice',
    name: 'Real Mango Fruit Power',
    brand: 'Real',
    netWeight: '1 L',
    categorySlug: 'beverages',
    isVeg: true,
  },
  {
    slug: 'tata-tea-gold',
    name: 'Tata Tea Gold',
    brand: 'Tata',
    netWeight: '250 g',
    categorySlug: 'beverages',
    isVeg: true,
  },
  {
    slug: 'nescafe-classic',
    name: 'Nescafé Classic Coffee',
    brand: 'Nescafé',
    netWeight: '100 g',
    categorySlug: 'beverages',
    isVeg: true,
  },

  // ── Staples & Grains ────────────────────────────────────────────────────
  {
    slug: 'aashirvaad-atta',
    name: 'Aashirvaad Whole Wheat Atta',
    brand: 'Aashirvaad',
    netWeight: '5 kg',
    categorySlug: 'staples-grains',
    isVeg: true,
  },
  {
    slug: 'india-gate-basmati',
    name: 'India Gate Basmati Rice',
    brand: 'India Gate',
    netWeight: '5 kg',
    categorySlug: 'staples-grains',
    isVeg: true,
  },
  {
    slug: 'fortune-sunflower-oil',
    name: 'Fortune Sunflower Oil',
    brand: 'Fortune',
    netWeight: '1 L',
    categorySlug: 'staples-grains',
    isVeg: true,
  },
  {
    slug: 'toor-dal',
    name: 'Toor Dal Arhar',
    netWeight: '1 kg',
    categorySlug: 'staples-grains',
    isVeg: true,
  },
  {
    slug: 'mdh-garam-masala',
    name: 'MDH Garam Masala',
    brand: 'MDH',
    netWeight: '100 g',
    categorySlug: 'staples-grains',
    isVeg: true,
  },
  {
    slug: 'everest-turmeric',
    name: 'Everest Turmeric Powder',
    brand: 'Everest',
    netWeight: '100 g',
    categorySlug: 'staples-grains',
    isVeg: true,
  },
  {
    slug: 'red-chilli-powder',
    name: 'Red Chilli Powder',
    netWeight: '200 g',
    categorySlug: 'staples-grains',
    isVeg: true,
  },

  // ── Personal Care (OFF has limited non-food coverage; resolve best-effort) ─
  {
    slug: 'head-shoulders-shampoo',
    name: 'Head & Shoulders Shampoo',
    brand: 'Head & Shoulders',
    netWeight: '340 ml',
    categorySlug: 'personal-care',
  },
  {
    slug: 'dove-soap',
    name: 'Dove Beauty Bar',
    brand: 'Dove',
    netWeight: '100 g',
    categorySlug: 'personal-care',
  },
  {
    slug: 'pampers-diapers',
    name: 'Pampers Diapers Medium',
    brand: 'Pampers',
    netWeight: '20 pack',
    categorySlug: 'personal-care',
  },

  // ── Household ───────────────────────────────────────────────────────────
  {
    slug: 'surf-excel',
    name: 'Surf Excel Easy Wash',
    brand: 'Surf Excel',
    netWeight: '1.5 kg',
    categorySlug: 'household',
  },
  {
    slug: 'lizol-floor-cleaner',
    name: 'Lizol Floor Cleaner',
    brand: 'Lizol',
    netWeight: '500 ml',
    categorySlug: 'household',
  },

  // ── Frozen ──────────────────────────────────────────────────────────────
  {
    slug: 'amul-ice-cream-vanilla',
    name: 'Amul Vanilla Ice Cream',
    brand: 'Amul',
    netWeight: '1 L',
    categorySlug: 'frozen',
    isVeg: true,
  },
  {
    slug: 'aashirvaad-paratha',
    name: 'Aashirvaad Frozen Paratha',
    brand: 'Aashirvaad',
    netWeight: '5 pack',
    categorySlug: 'frozen',
    isVeg: true,
  },
] as const;

/** The OFF free-text query for a curated product (`searchTerms` or brand+name). */
export function curatedSearchQuery(seed: CuratedProductSeed): string {
  if (seed.searchTerms && seed.searchTerms.trim().length > 0) return seed.searchTerms.trim();
  return [seed.brand, seed.name].filter(Boolean).join(' ').trim();
}
