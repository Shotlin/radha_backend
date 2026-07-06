/**
 * BE-40 — Slug normalisation.
 *
 * Ingredient slugs are derived from arbitrary input (URL parameter,
 * raw OCR text, OFF ingredient list). Normalisation rules:
 *
 *   1. NFKD-normalise + strip diacritics so "Açaí" → "acai".
 *   2. Lowercase.
 *   3. Replace any run of non-alphanumeric characters with a single
 *      hyphen.
 *   4. Trim leading / trailing hyphens.
 *
 * The result is a lowercase kebab-case slug containing only
 * `[a-z0-9-]`. Empty input (or input that becomes empty after
 * sanitisation) yields the empty string — callers must reject it.
 */
export function normaliseIngredientSlug(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  const stringified = typeof input === 'string' ? input : String(input);
  return stringified
    .normalize('NFKD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse runs of non-alnum to single hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

/**
 * True when `slug` already conforms to the normalisation contract:
 * non-empty, lowercase, and only `[a-z0-9-]` (no leading/trailing
 * hyphen, no consecutive hyphens).
 */
export function isNormalisedIngredientSlug(slug: string): boolean {
  if (!slug) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
