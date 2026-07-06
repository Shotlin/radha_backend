/**
 * BE-37 — Allergen types and enums.
 */

export const AGE_BANDS = ['infant', 'toddler', 'child', 'adolescent', 'adult', 'senior'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const ALLERGEN_TAGS = [
  'peanut',
  'tree_nut',
  'milk',
  'egg',
  'wheat',
  'gluten',
  'soy',
  'fish',
  'shellfish',
  'sesame',
  'mustard',
  'celery',
  'lupin',
  'molluscs',
  'sulphites',
] as const;
export type AllergenTag = (typeof ALLERGEN_TAGS)[number];

export const CONDITION_TAGS = [
  'diabetes',
  'hypertension',
  'celiac',
  'lactose_intolerance',
  'ibs',
  'gout',
  'kidney_disease',
  'heart_disease',
  'obesity',
  'pcod',
] as const;
export type ConditionTag = (typeof CONDITION_TAGS)[number];

export interface AllergenProfileQuota {
  maxProfiles: number;
  currentCount: number;
  remaining: number;
}

export interface IAllergenProfileService {
  upsert(
    tenantId: string,
    userId: string,
    dto: unknown,
    planCode?: string,
  ): Promise<unknown>;
  listByUser(tenantId: string, userId: string): Promise<unknown[]>;
  delete(tenantId: string, userId: string, id: string): Promise<{ success: boolean }>;
  setActive(tenantId: string, userId: string, id: string): Promise<unknown>;
  matchAllergens(
    tenantId: string,
    profileId: string,
    ingredients: string[],
    productAllergens: string[],
  ): Promise<unknown[]>;
}
