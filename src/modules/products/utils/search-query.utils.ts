/**
 * BE-14 — search query helpers.
 *
 * `sanitiseQuery` cleans user input before it goes into either:
 *   - `plainto_tsquery('english', q)`  — Postgres handles unsafe chars
 *     itself, but we still strip control chars + cap length here to
 *     keep the query path predictable.
 *   - the trigram fallback `name ILIKE '%q%'` — same cap, plus we
 *     escape `%` and `_` so the user's `%` literal doesn't accidentally
 *     turn into the LIKE wildcard.
 *
 * SQL injection is already covered by Drizzle's parameter binding;
 * these helpers exist to keep the query stable, not to add safety on
 * top of parameterisation.
 */
const MAX_QUERY_LEN = 80;

export const sanitiseQuery = (raw: string | undefined | null): string => {
  if (!raw) return '';
  return (
    raw
      // strip control chars
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      // collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_QUERY_LEN)
  );
};

/**
 * Escape `%` and `_` for ILIKE patterns so `q="50%"` searches for the
 * literal string "50%" not "anything containing 50".
 */
export const escapeLikePattern = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

/**
 * Build a `name ILIKE` substring pattern after sanitising and escaping.
 */
export const ilikeSubstring = (raw: string): string => `%${escapeLikePattern(sanitiseQuery(raw))}%`;

/**
 * Prefix-only ILIKE (used by autocomplete).
 */
export const ilikePrefix = (raw: string): string => `${escapeLikePattern(sanitiseQuery(raw))}%`;

/**
 * Public so other modules (e.g. analytics) can reuse the cap.
 */
export const QUERY_LENGTH_LIMIT = MAX_QUERY_LEN;
