import { Injectable } from '@nestjs/common';

import type { ProductNutritionRow, ProductRow } from '@/db/schema/products';

import type {
  AllergenAlert,
  AllergenProfileMatch,
  UserAllergenProfile,
} from '../types/health.types';

/**
 * BE-12 — basic allergen detection.
 *
 * Allergen *content* discovery is intentionally simple: we trust the
 * `product_nutrition.containsAllergens` array that BE-11 already
 * populated from Open Food Facts, plus a tiny ingredient-string
 * fallback for the common Indian allergens (peanut, tree nut, milk,
 * egg, soy, wheat, sesame, fish, shellfish, mustard).
 *
 * Allergen *matching* against a user's profile is the BE-37 use
 * case — this service only takes the resolved profile (passed in)
 * and returns the matches. The actual profile lookup goes through
 * the `IAllergenProfileService` port, which BE-37 implements.
 *
 * NEVER add an external API call here. The scan response path must
 * stay free of network dependencies (Req 9 sub-section).
 */

const FALLBACK_ALLERGEN_KEYWORDS: ReadonlyMap<string, RegExp> = new Map([
  ['peanuts', /\bpeanuts?\b/i],
  [
    'tree_nuts',
    /\b(almonds?|walnuts?|cashews?|hazelnuts?|pistachios?|pecans?|macadamia|brazil\s*nuts?)\b/i,
  ],
  ['milk', /\b(milk|dairy|lactose|whey|casein|butter|ghee)\b/i],
  ['eggs', /\beggs?\b/i],
  ['soy', /\bsoy(?:beans?|a)?\b/i],
  ['gluten', /\b(gluten|wheat|barley|rye|maida|atta)\b/i],
  ['sesame', /\b(sesame|til\s*seeds?)\b/i],
  ['fish', /\bfish\b/i],
  ['shellfish', /\b(shellfish|prawns?|shrimps?|crabs?|lobsters?)\b/i],
  ['mustard', /\bmustard\b/i],
]);

@Injectable()
export class AllergenDetectionService {
  /**
   * Pull the canonical allergen tags off a product. Lower-case,
   * de-duplicated, sorted for stable output.
   */
  detectAllergens(product: ProductRow, nutrition?: ProductNutritionRow | null): AllergenAlert[] {
    const declared = this.extractDeclared(nutrition);
    const inferredFromIngredients = this.extractFromText(product.description ?? '');
    const inferredFromName = this.extractFromText(product.name);

    const set = new Map<string, AllergenAlert>();
    for (const tag of declared) {
      set.set(tag, { allergen: tag, severity: 'severe', source: 'declared' });
    }
    for (const tag of [...inferredFromIngredients, ...inferredFromName]) {
      if (!set.has(tag)) {
        set.set(tag, { allergen: tag, severity: 'moderate', source: 'detected' });
      }
    }
    return [...set.values()].sort((a, b) => a.allergen.localeCompare(b.allergen));
  }

  /**
   * Match detected allergens against a user's profile.
   * Returns one entry per matching tag/family-member pair.
   */
  matchUserAllergens(
    detected: AllergenAlert[],
    profile: UserAllergenProfile | null | undefined,
  ): AllergenProfileMatch[] {
    if (!profile || detected.length === 0) return [];
    const hasProfileTags = profile.tags.length > 0;
    const hasMemberTags = profile.members.some((m) => m.tags.length > 0);
    if (!hasProfileTags && !hasMemberTags) return [];

    const detectedSet = new Set(detected.map((a) => a.allergen.toLowerCase()));
    const matches: AllergenProfileMatch[] = [];

    // Profile-level tags first (covers users without per-member breakdown).
    for (const tag of profile.tags) {
      if (detectedSet.has(tag.toLowerCase())) {
        matches.push({
          allergen: tag.toLowerCase(),
          matchedTag: tag,
          severity:
            detected.find((d) => d.allergen.toLowerCase() === tag.toLowerCase())?.severity ??
            'moderate',
        });
      }
    }
    // Per-member matches.
    for (const member of profile.members) {
      for (const tag of member.tags) {
        if (detectedSet.has(tag.toLowerCase())) {
          matches.push({
            allergen: tag.toLowerCase(),
            matchedTag: tag,
            familyMemberId: member.id,
            familyMemberName: member.name,
            severity: member.severity,
          });
        }
      }
    }
    return matches;
  }

  private extractDeclared(nutrition?: ProductNutritionRow | null): string[] {
    if (!nutrition?.containsAllergens) return [];
    const raw = nutrition.containsAllergens;
    if (!Array.isArray(raw)) return [];
    const out = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const cleaned = entry
        .replace(/^[a-z]{2}:/i, '')
        .trim()
        .toLowerCase();
      if (cleaned.length > 0) out.add(cleaned);
    }
    return [...out];
  }

  private extractFromText(text: string): string[] {
    if (!text || text.length === 0) return [];
    const out = new Set<string>();
    for (const [tag, re] of FALLBACK_ALLERGEN_KEYWORDS) {
      if (re.test(text)) out.add(tag);
    }
    return [...out];
  }
}
