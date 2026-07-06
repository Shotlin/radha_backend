/**
 * BE-37 — Allergen match response DTO.
 */

export interface AllergenMatchResponse {
  profileId: string;
  profileDisplayName: string;
  matches: AllergenMatchItem[];
  hasMatches: boolean;
  matchCount: number;
}

export interface AllergenMatchItem {
  /** The allergen tag from the profile (e.g. 'peanut') */
  tag: string;
  /** Where the match was found */
  matchedIn: 'ingredient' | 'allergen_declaration';
  /** The actual term that matched (could be a synonym) */
  matchedTerm: string;
  /** Severity: high = direct match, medium = partial, low = synonym */
  severity: 'high' | 'medium' | 'low';
}
