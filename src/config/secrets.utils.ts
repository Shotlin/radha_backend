/**
 * Secret-aware logging helpers.
 *
 * Any time we serialize config or env data for logs, error messages,
 * or the `/health/config` debug endpoint, we MUST run values through
 * the maskers in this file. Leaking a database password or JWT
 * secret into logs is a phase-blocking incident.
 */

const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /credential/i,
  /authorization/i,
] as const;

export const isSecretKey = (key: string): boolean =>
  SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));

export const maskSecret = (value: unknown): string => {
  if (value === null || value === undefined) return '<undefined>';
  const str = String(value);
  if (str.length === 0) return '<empty>';
  if (str.length <= 4) return '****';
  if (str.length <= 8) return `${str.slice(0, 2)}****`;
  return `${str.slice(0, 4)}****${str.slice(-2)}`;
};

/**
 * Recursively walks a plain object and replaces any value whose key
 * matches a secret pattern with a masked placeholder. Used by
 * `ConfigService.getAll()` so the dev-only `/health/config` endpoint
 * never returns raw secrets.
 */
export const maskObject = <T extends Record<string, unknown>>(obj: T): T => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = maskObject(value as Record<string, unknown>);
    } else if (isSecretKey(key) && (typeof value === 'string' || typeof value === 'number')) {
      result[key] = maskSecret(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
};
