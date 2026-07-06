/**
 * PII redaction utilities.
 *
 * Used by the global exception filter, request logger middleware, and
 * Pino's transport-side `redact.paths`. Two complementary mechanisms:
 *
 *   1. Field-name allowlist  — keys whose name *contains* a sensitive
 *      term are replaced wholesale with `[REDACTED]`.
 *   2. Value-pattern matching — strings that match an Indian Aadhaar,
 *      PAN, mobile, or 16-digit card pattern are redacted in-place
 *      anywhere they appear.
 *
 * Everything is structural — no `eval`, no global state. Safe to call
 * on the request body, headers, query, or any nested log payload.
 */

const SENSITIVE_FIELD_TERMS: readonly string[] = [
  'password',
  'otp',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'mobile',
  'phone',
  'email',
  'aadhaar',
  'pan',
  'creditcard',
  'card_number',
  'cvv',
  'ssn',
  'apikey',
  'secret',
  'private_key',
  'access_key',
  'jwt_access',
];

const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\b\d{4}\s?\d{4}\s?\d{4}\b/g, // Aadhaar (12 digits, optional spaces)
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // PAN
  /\b\d{16}\b/g, // 16-digit card
  /\b[6-9]\d{9}\b/g, // Indian mobile
];

const REDACTED = '[REDACTED]';

const isSensitiveKey = (key: string): boolean => {
  const lower = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_FIELD_TERMS.some((term) => lower.includes(term.replace(/[_-]/g, '')));
};

const redactString = (value: string): string => {
  let result = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
};

/**
 * Recursively redacts PII from a structure, returning a new value of
 * the same shape. Cycles are not expected on log payloads but are
 * defended against via a `WeakSet` cache to avoid runaway recursion
 * just in case.
 */
export const redactPII = <T>(value: T, seen: WeakSet<object> = new WeakSet()): T => {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value) as unknown as T;
  }

  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactPII(item, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactPII(child, seen);
  }
  return out as unknown as T;
};
