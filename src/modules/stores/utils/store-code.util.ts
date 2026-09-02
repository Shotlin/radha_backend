import { randomBytes } from 'node:crypto';

/**
 * Short store code generator.
 *
 * Mirrors `modules/referrals/utils/referral-code.util.ts`: an 8-character
 * uppercase alphanumeric string from a 32-symbol Crockford-flavoured
 * alphabet (digits + uppercase letters minus the look-alike characters
 * `I`, `L`, `O`, `U`), so it's legible when read aloud or typed from a
 * screenshot. Shown to the owner/auditor in place of the raw store `id`
 * UUID (e.g. Profile screen's "Store ID").
 *
 * Each character is sampled from a cryptographic random byte; bytes that
 * fall outside the unbiased range are rejected so the symbol distribution
 * stays uniform.
 */

export const STORE_CODE_LENGTH = 8;

const STORE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const ALPHABET_LENGTH = STORE_CODE_ALPHABET.length;

/** Highest unbiased byte value for the alphabet (rejection sampling). */
const MAX_ACCEPTED_BYTE = Math.floor(256 / ALPHABET_LENGTH) * ALPHABET_LENGTH - 1;

/**
 * Generate a single 8-char uppercase alphanumeric store code.
 *
 * Collisions are negligible (~1.5e-12 per pair at 1B stores) but the
 * `stores_short_code_unique` index is the real guarantee — callers that
 * insert outside a retry loop (the onboarding/business-activation
 * transactions) accept that risk rather than adding transactional
 * requery complexity for a probability this small; `StoresService.create`
 * (the general-purpose, non-transactional path) retries on collision.
 */
export function generateStoreCode(): string {
  let result = '';
  while (result.length < STORE_CODE_LENGTH) {
    const buf = randomBytes(STORE_CODE_LENGTH * 2);
    for (let i = 0; i < buf.length && result.length < STORE_CODE_LENGTH; i += 1) {
      const byte = buf[i];
      if (byte > MAX_ACCEPTED_BYTE) continue;
      result += STORE_CODE_ALPHABET[byte % ALPHABET_LENGTH];
    }
  }
  return result;
}
