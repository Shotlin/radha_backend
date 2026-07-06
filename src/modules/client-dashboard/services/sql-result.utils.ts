/**
 * BE-30 — Shared helpers for reading raw SQL results.
 *
 * Drizzle's `db.execute()` returns either a `RowList<Row[]>` (the
 * postgres-js driver — what the project ships with) or a
 * `{ rows: Row[] }` shape (neon, pg). Reading both via a tiny helper
 * keeps the calculators and aggregators driver-agnostic.
 */

export function rowAt<T = Record<string, unknown>>(result: unknown, index = 0): T | undefined {
  if (Array.isArray(result)) return result[index] as T | undefined;
  const r = result as { rows?: T[] } | undefined;
  return r?.rows?.[index];
}

export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] } | undefined;
  return r?.rows ?? [];
}

export function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}
