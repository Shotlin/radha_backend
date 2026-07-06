import { Injectable } from '@nestjs/common';

import type { AllergenProfileRow } from '@/db/schema/allergen-profiles';

/**
 * BE-37 — Allergen matcher.
 *
 * Matches a profile's allergy_tags against product ingredient lists
 * and product-level allergen declarations. Handles:
 *   - Case-insensitive matching
 *   - Known synonyms (e.g. peanut ↔ groundnut, milk ↔ dairy)
 *   - Partial-word detection in ingredient strings
 */

export interface AllergenMatch {
  tag: string;
  matchedIn: 'ingredient' | 'allergen_declaration';
  matchedTerm: string;
  severity: 'high' | 'medium' | 'low';
}

/** Map of allergen → known synonyms (all lowercase). */
const ALLERGEN_SYNONYMS: Record<string, string[]> = {
  peanut: ['groundnut', 'arachis', 'monkey nut'],
  groundnut: ['peanut', 'arachis', 'monkey nut'],
  milk: ['dairy', 'lactose', 'casein', 'whey'],
  dairy: ['milk', 'lactose', 'casein', 'whey'],
  lactose: ['milk', 'dairy'],
  wheat: ['gluten', 'flour', 'semolina', 'maida'],
  gluten: ['wheat', 'barley', 'rye', 'flour', 'maida'],
  soy: ['soya', 'soybean', 'soy lecithin'],
  soya: ['soy', 'soybean', 'soy lecithin'],
  egg: ['eggs', 'albumin', 'ovalbumin'],
  eggs: ['egg', 'albumin', 'ovalbumin'],
  tree_nut: ['almond', 'cashew', 'walnut', 'pistachio', 'hazelnut', 'macadamia', 'pecan'],
  shellfish: ['shrimp', 'crab', 'lobster', 'prawn', 'crayfish'],
  fish: ['anchovy', 'cod', 'salmon', 'tuna', 'sardine'],
  sesame: ['til', 'gingelly'],
  mustard: ['sarson', 'rai'],
};

@Injectable()
export class AllergenMatcherService {
  /**
   * Match a profile's allergy tags against product data.
   *
   * @param profile    The allergen profile to check against.
   * @param ingredients  Array of ingredient strings from the product.
   * @param productAllergens  Declared allergens on the product (e.g. from label).
   */
  match(
    profile: Pick<AllergenProfileRow, 'allergyTags'>,
    ingredients: string[],
    productAllergens: string[],
  ): AllergenMatch[] {
    const matches: AllergenMatch[] = [];
    const normalizedIngredients = ingredients.map((i) => i.toLowerCase());
    const normalizedAllergens = productAllergens.map((a) => a.toLowerCase());

    for (const tag of profile.allergyTags) {
      const normalizedTag = tag.toLowerCase().trim();
      const termsToCheck = [normalizedTag, ...(ALLERGEN_SYNONYMS[normalizedTag] ?? [])];

      // Check against ingredient list
      for (const term of termsToCheck) {
        for (const ingredient of normalizedIngredients) {
          if (ingredient.includes(term)) {
            matches.push({
              tag,
              matchedIn: 'ingredient',
              matchedTerm: term,
              severity: this.computeSeverity(normalizedTag, ingredient),
            });
            break; // one match per term in ingredients is enough
          }
        }
      }

      // Check against product allergen declarations
      for (const term of termsToCheck) {
        for (const allergen of normalizedAllergens) {
          if (allergen.includes(term) || term.includes(allergen)) {
            matches.push({
              tag,
              matchedIn: 'allergen_declaration',
              matchedTerm: term,
              severity: 'high',
            });
            break;
          }
        }
      }
    }

    // Deduplicate by tag + matchedIn
    return this.deduplicate(matches);
  }

  /**
   * Compute severity based on how direct the match is.
   */
  private computeSeverity(tag: string, ingredient: string): 'high' | 'medium' | 'low' {
    // Direct match (tag appears as a standalone word in ingredient)
    const wordBoundary = new RegExp(`\\b${this.escapeRegex(tag)}\\b`, 'i');
    if (wordBoundary.test(ingredient)) {
      return 'high';
    }
    // Partial match (tag is substring)
    if (ingredient.includes(tag)) {
      return 'medium';
    }
    // Synonym match
    return 'low';
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private deduplicate(matches: AllergenMatch[]): AllergenMatch[] {
    const seen = new Set<string>();
    return matches.filter((m) => {
      const key = `${m.tag}:${m.matchedIn}:${m.matchedTerm}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
