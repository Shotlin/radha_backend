/**
 * BE-18 — Platform-default expiry thresholds.
 *
 * Yellow = "near expiry, plan a discount/sell-through".
 * Red    = "imminent expiry, urgent action".
 *
 * Numbers reflect Indian retail norms cross-checked against:
 *   - FSSAI shelf-life advisories,
 *   - WHO/IMA pharmacy stocking guidelines,
 *   - common practice in supermarket SOPs.
 *
 * Tenants override per-category via `expiry_thresholds` rows with a
 * non-null `tenant_id`. The `'other'` fallback applies when a product
 * has no `subCategory` mapped.
 */

export interface DefaultThreshold {
  category: string;
  yellowDays: number;
  redDays: number;
  description: string;
}

export const DEFAULT_EXPIRY_THRESHOLDS: ReadonlyArray<DefaultThreshold> = Object.freeze([
  {
    category: 'dairy',
    yellowDays: 7,
    redDays: 2,
    description: 'Milk, yogurt, paneer, cheese — short shelf life',
  },
  {
    category: 'meat-seafood',
    yellowDays: 5,
    redDays: 1,
    description: 'Fresh meat, seafood — very short shelf life',
  },
  {
    category: 'bakery',
    yellowDays: 7,
    redDays: 2,
    description: 'Bread, pastries, fresh sweets — short shelf life',
  },
  {
    category: 'fruits-vegetables',
    yellowDays: 5,
    redDays: 1,
    description: 'Fresh produce — perishable, FIFO critical',
  },
  {
    category: 'frozen',
    yellowDays: 30,
    redDays: 7,
    description: 'Frozen ready-meals, frozen vegetables',
  },
  {
    category: 'snacks',
    yellowDays: 30,
    redDays: 7,
    description: 'Chips, biscuits, namkeen',
  },
  {
    category: 'beverages',
    yellowDays: 60,
    redDays: 14,
    description: 'Soft drinks, juices, milk-tea',
  },
  {
    category: 'medicine',
    yellowDays: 90,
    redDays: 30,
    description: 'OTC pharmaceuticals — strict regulatory floor',
  },
  {
    category: 'cosmetics',
    yellowDays: 60,
    redDays: 14,
    description: 'Personal care, skin care, hair care',
  },
  {
    category: 'household',
    yellowDays: 180,
    redDays: 30,
    description: 'Cleaning supplies, detergents',
  },
  {
    category: 'baby',
    yellowDays: 30,
    redDays: 7,
    description: 'Infant formula, baby food, diapers',
  },
  {
    category: 'pet',
    yellowDays: 60,
    redDays: 14,
    description: 'Pet food and supplies',
  },
  {
    category: 'other',
    yellowDays: 30,
    redDays: 7,
    description: 'Default for uncategorised products',
  },
]);

/** Quick lookup helper. Falls back to the `other` row when missing. */
export const getDefaultThreshold = (category: string | null | undefined): DefaultThreshold => {
  if (!category) {
    return DEFAULT_EXPIRY_THRESHOLDS.find((t) => t.category === 'other')!;
  }
  const lower = category.toLowerCase();
  return (
    DEFAULT_EXPIRY_THRESHOLDS.find((t) => t.category === lower) ??
    DEFAULT_EXPIRY_THRESHOLDS.find((t) => t.category === 'other')!
  );
};
