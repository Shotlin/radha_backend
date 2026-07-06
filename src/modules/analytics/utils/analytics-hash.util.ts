import * as crypto from 'crypto';

/**
 * BE-29 — Salted SHA-256 hash for analytics PII anonymization.
 *
 * Used to hash visitor cookies / session ids before storing them.
 * Same input + same salt produces the same hash, so de-duplication
 * still works. Different salts produce completely different hashes,
 * so rotating `ANALYTICS_HASH_SALT` makes historical data unjoinable
 * to new data.
 *
 * Throws if the salt is missing or shorter than 32 chars — the boot
 * process surfaces this loudly so prod can never come up with a
 * broken privacy posture.
 */

export const MIN_SALT_LENGTH = 32;

export class AnalyticsSaltMissingError extends Error {
  constructor() {
    super(
      'ANALYTICS_HASH_SALT is required for analytics PII hashing and must be at least 32 chars',
    );
    this.name = 'AnalyticsSaltMissingError';
  }
}

export const assertValidSalt = (salt: string | undefined): string => {
  if (!salt || salt.length < MIN_SALT_LENGTH) {
    throw new AnalyticsSaltMissingError();
  }
  return salt;
};

export const sha256WithSalt = (value: string, salt: string): string => {
  const safeSalt = assertValidSalt(salt);
  return crypto.createHash('sha256').update(`${value}:${safeSalt}`).digest('hex');
};
