import type { OrderByClause } from './base.repository.types';

/**
 * Cursor pagination encoder/decoder.
 *
 * The cursor is a base64url-encoded JSON object with one entry per
 * orderBy field, e.g. `{ "createdAt": "2026-05-17T..." , "id": "..." }`.
 * Decoding is intentionally permissive — anything we can't parse turns
 * into a `null` cursor so the next page resolves to "start over".
 */

export const encodeCursor = (record: Record<string, unknown>, orderBy: OrderByClause[]): string => {
  const cursorData: Record<string, unknown> = {};
  for (const clause of orderBy) {
    cursorData[clause.field] = record[clause.field];
  }
  return Buffer.from(JSON.stringify(cursorData), 'utf8').toString('base64url');
};

export const decodeCursor = (cursor: string): Record<string, unknown> | null => {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};
