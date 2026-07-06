import type { ProductNutritionRow, ProductRow } from '@/db/schema/products';

/**
 * BE-12 — Health Scoring Engine.
 *
 * Public type surface. The engine, the persistence layer, and the
 * controller all consume these — no other module should redefine
 * any of these shapes.
 */

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'U';

/** Traffic-light status returned to the Mobile_App (Req 4). */
export type HealthStatus = 'green' | 'yellow' | 'red' | 'data_unavailable';

export type ProcessingLevel = 'not' | 'lightly' | 'ultra' | 'unknown';

export type ChildSafetyStatus = 'suitable' | 'caution' | 'unsuitable' | 'unknown';

export type AgeBand = 'infant' | 'toddler' | 'child' | 'adolescent' | 'adult';

export type WarningType =
  | 'high_sugar'
  | 'high_oil'
  | 'high_sodium'
  | 'high_saturated_fat'
  | 'trans_fat'
  | 'ultra_processed'
  | 'artificial_sweetener'
  | 'insufficient_data'
  | 'other';

export type PositiveType =
  | 'high_protein'
  | 'high_fiber'
  | 'low_sugar'
  | 'low_sodium'
  | 'no_trans_fat'
  | 'natural'
  | 'other';

export type AllergenSeverity = 'mild' | 'moderate' | 'severe';
export type AllergenSource = 'declared' | 'detected' | 'cross-contamination';

export type Severity = 'low' | 'medium' | 'high';

export interface HealthWarning {
  type: WarningType;
  severity: Severity;
  message: string;
  threshold: number;
  actual: number;
  unit: string;
}

export interface HealthPositive {
  type: PositiveType;
  message: string;
}

export interface AllergenAlert {
  allergen: string; // canonical lowercase token, e.g. 'peanuts'
  severity: AllergenSeverity;
  source: AllergenSource;
}

export interface AgeBandSafety {
  infantSafe: boolean; // 0–2 yr
  toddlerSafe: boolean; // 2–5 yr
  childSafe: boolean; // 5–12 yr
  adolescentSafe: boolean; // 12–18 yr
  rationale: string;
}

export interface ConsumptionGuidance {
  /** "Limit to once a week", "Daily ok", … — already-localised user copy. */
  summary: string;
  /** Suggested portion in grams. May be omitted when data is missing. */
  portionGrams?: number;
  /** Suggested cadence: e.g. 'occasional', 'weekly', 'daily'. */
  cadence: 'avoid' | 'rare' | 'occasional' | 'weekly' | 'daily';
  /** Bullet points for the Mobile_App tip section. */
  notes: string[];
}

export interface ChildSafetyResult {
  status: ChildSafetyStatus;
  reasons: string[];
  ageRecommendation?: AgeBand;
}

export interface ScoringInput {
  product: ProductRow;
  nutrition?: ProductNutritionRow | null;
  ruleVersion?: string;
}

export interface ScoringOutput {
  productId: string;
  overallGrade: HealthGrade;
  overallScore: number; // 0..100
  healthStatus: HealthStatus;
  childSafety: ChildSafetyResult;
  warnings: HealthWarning[];
  positives: HealthPositive[];
  allergens: AllergenAlert[];
  isProcessed: ProcessingLevel;
  tags: string[];
  ruleVersion: string;
  computedAt: Date;
}

export interface RuleResult {
  triggered: boolean;
  score: number; // delta to apply to the running total (negative = penalty)
  warning?: HealthWarning;
  positive?: HealthPositive;
}

export interface HealthRule {
  id: string;
  version: string;
  name: string;
  category: 'sugar' | 'oil' | 'sodium' | 'fat' | 'processing' | 'allergen' | 'positive';
  weight: number; // 0..1, advisory only — used by validateRules
  evaluator: (input: ScoringInput) => RuleResult;
}

export interface RuleValidationResult {
  valid: boolean;
  errors: string[];
}

/* ─────────────────── Public read DTOs (BE-12 v2 ADDENDUM) ─────────────────── */

export interface BasicScanOutput {
  ean: string;
  name: string;
  brand: string | null;
  healthStatus: HealthStatus;
  expiryStatus: 'green' | 'yellow' | 'red' | 'unknown';
}

export interface AllergenProfileMatch {
  allergen: string;
  matchedTag: string;
  familyMemberId?: string;
  familyMemberName?: string;
  severity: AllergenSeverity;
}

export interface HealthCon {
  type: WarningType;
  severity: Severity;
  message: string;
}

export interface HealthierAlternativeStub {
  productId: string;
  ean: string;
  name: string;
  brand: string | null;
  healthScore: number;
  reason: string;
  affiliateUrl?: string;
}

export interface ComprehensiveScanOutput extends BasicScanOutput {
  ingredients: string[];
  allergensDetected: string[];
  pros: string[];
  cons: HealthCon[];
  ageBandSafety: AgeBandSafety;
  consumptionGuidance: ConsumptionGuidance;
  /**
   * BE-41 fills this slot. BE-12 leaves it as an empty array.
   */
  healthierAlternatives: HealthierAlternativeStub[];
  allergenProfileMatches: AllergenProfileMatch[];
  overallGrade: HealthGrade;
  overallScore: number;
  isProcessed: ProcessingLevel;
  warnings: HealthWarning[];
  positives: HealthPositive[];
  ruleVersion: string;
  computedAt: string; // ISO string
}

/* ─────────────────── Filters / stats ─────────────────── */

export interface HealthFilters {
  childSafe?: boolean;
  noUltraProcessed?: boolean;
  maxSugarPer100g?: number;
  maxSodiumPer100g?: number;
  excludeAllergens?: string[];
  minGrade?: 'A' | 'B' | 'C' | 'D' | 'E';
  limit?: number;
}

export interface HealthStats {
  totalProducts: number;
  graded: { A: number; B: number; C: number; D: number; E: number; U: number };
  childSafe: number;
  ultraProcessed: number;
  withAllergens: number;
}

/* ─────────────────── BE-37 hand-off interfaces ─────────────────── */

/**
 * BE-37 owns the Allergen_Profile data. BE-12 only consumes it via
 * this read-only port. Until BE-37 lands, the default no-op
 * implementation in `health-scoring.module.ts` returns `null`.
 */
export interface IAllergenProfileService {
  /** Returns the active profile for a user (or null when none exists). */
  getActiveProfile(userId: string): Promise<UserAllergenProfile | null>;

  /** Returns a profile by id. */
  getProfile(profileId: string): Promise<UserAllergenProfile | null>;
}

export interface UserAllergenProfile {
  id: string;
  userId: string;
  /** All allergen tags (lowercased) the user/family is sensitive to. */
  tags: string[];
  members: AllergenProfileMember[];
}

export interface AllergenProfileMember {
  id: string;
  name: string;
  tags: string[];
  severity: AllergenSeverity;
}
