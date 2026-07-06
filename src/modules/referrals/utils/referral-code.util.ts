import { randomBytes } from 'node:crypto';

/**
 * BE-43 — Referral code generator.
 *
 * The code is an 8-character uppercase alphanumeric string. We use a
 * 32-symbol alphabet (Crockford-flavoured: digits + uppercase letters
 * minus the look-alike characters `I`, `L`, `O`, `U`) to keep codes
 * legible when typed from a screenshot or read aloud.
 *
 * Each character is sampled from a cryptographic random byte; bytes
 * that fall outside the unbiased range are rejected so the symbol
 * distribution stays uniform.
 */

export const REFERRAL_CODE_LENGTH = 8;

const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const ALPHABET_LENGTH = REFERRAL_CODE_ALPHABET.length;

/**
 * Highest unbiased byte value for the alphabet (rejection sampling).
 * `Math.floor(256 / N) * N - 1` keeps each byte mapping to exactly
 * `floor(256 / N)` symbols.
 */
const MAX_ACCEPTED_BYTE = Math.floor(256 / ALPHABET_LENGTH) * ALPHABET_LENGTH - 1;

/**
 * Generate a single 8-char uppercase alphanumeric referral code.
 *
 * Collisions: at 1B users, two random codes collide with probability
 * ≈ 1 / 30^8 ≈ 1.5e-12 per pair. The service still wraps creation in
 * a unique-index retry loop so concurrent inserts never violate the
 * `users_referral_code_unique` constraint.
 */
export function generateReferralCode(): string {
  let result = '';
  while (result.length < REFERRAL_CODE_LENGTH) {
    const buf = randomBytes(REFERRAL_CODE_LENGTH * 2);
    for (let i = 0; i < buf.length && result.length < REFERRAL_CODE_LENGTH; i += 1) {
      const byte = buf[i];
      if (byte > MAX_ACCEPTED_BYTE) continue;
      result += REFERRAL_CODE_ALPHABET[byte % ALPHABET_LENGTH];
    }
  }
  return result;
}

/**
 * Normalise user-supplied codes (mobile clients may forward whatever
 * the user typed). Trims surrounding whitespace and uppercases the
 * value, but does NOT silently strip characters — the service treats
 * any code that can't match an existing record as invalid.
 */
export function normaliseReferralCode(input: string): string {
  return input.trim().toUpperCase();
}

/**
 * `true` when the input is the canonical 8-char A-Z/0-9 form. Used by
 * the Zod schema as a defence-in-depth check; the service still falls
 * back on the silent-rejection branch for codes that pass shape
 * validation but don't match any user.
 */
export function isWellFormedReferralCode(input: string): boolean {
  return /^[A-Z0-9]{8}$/.test(input);
}
