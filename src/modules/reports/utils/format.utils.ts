/**
 * BE-21 — Pure formatting helpers shared by every exporter.
 *
 *   - `humaniseHeader`  — turns `redCount` / `red_count` / `RED_COUNT`
 *                         into `Red Count` so column headers look
 *                         decent without forcing each generator to
 *                         pre-format their keys.
 *   - `formatCellValue` — flattens any JSON value into a string the
 *                         spreadsheet/PDF/CSV layers can render
 *                         consistently.
 *   - `sanitizeFormula` — defends against CSV/Excel formula injection
 *                         (`=cmd|...`) by quoting any cell that begins
 *                         with `= + - @ \t \r`.
 *
 * Keeping these here, free of NestJS, makes them trivially testable.
 */

const HEADER_BOUNDARY = /([a-z])([A-Z])|[_\-\s]+/g;

export function humaniseHeader(key: string): string {
  if (!key) return '';
  const spaced = key.replace(HEADER_BOUNDARY, (_, lower?: string, upper?: string) =>
    lower && upper ? `${lower} ${upper}` : ' ',
  );
  return spaced
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Excel/Sheets/CSV interpret cells that start with `=` etc. as
 * formulas — including ones that exfiltrate data via `WEBSERVICE`.
 * Prepending an apostrophe (which Excel renders invisibly) neutralises
 * the formula without changing the displayed value.
 *
 * See OWASP CSV-injection guidance for the full attack surface.
 */
export function sanitizeFormula(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  return FORMULA_PREFIXES.includes(value[0] as string) ? `'${value}` : value;
}

/**
 * Derive a column ordering from the first non-empty row. Honours
 * insertion order of `Object.keys`, which V8 preserves for
 * string-keyed properties.
 */
export function inferHeaders(rows: Record<string, unknown>[]): string[] {
  for (const row of rows) {
    if (row && typeof row === 'object') {
      const keys = Object.keys(row);
      if (keys.length > 0) return keys;
    }
  }
  return [];
}

/**
 * Slugify into a filesystem/S3-safe segment.
 *
 *   "Expiry — Q1 / 2026.xlsx"  →  "expiry-q1-2026-xlsx"
 *
 * Used to build the user-visible `fileName` we return to the
 * Mobile_App.
 */
export function slugifyForFilename(input: string, maxLength = 80): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'report').slice(0, maxLength);
}
