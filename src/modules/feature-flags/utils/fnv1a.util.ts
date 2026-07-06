/**
 * BE-47 — FNV-1a 32-bit hash, used for sticky bucketing of users into
 * a flag rollout cohort.
 *
 * Why FNV-1a:
 *   - deterministic across processes (no random salts),
 *   - tiny — ~10 lines, no native dependency,
 *   - well-known avalanche behaviour for short strings like
 *     `${flagName}:${userId}`, which is what we're hashing.
 *
 * The result is a 32-bit unsigned integer the caller mods into a
 * smaller range (mod 100 for percent rollouts, mod sum-of-weights for
 * multivariate).
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Hash a string with FNV-1a (32-bit). Always non-negative.
 *
 * Implementation note: `Math.imul` keeps the multiplication inside
 * 32-bit signed range; `>>> 0` re-interprets the bit pattern as an
 * unsigned int so callers can safely `% n` it.
 */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Map a string into `[0, mod)` deterministically. `mod` must be > 0. */
export function bucketOf(input: string, mod: number): number {
  if (mod <= 0) return 0;
  return fnv1a32(input) % mod;
}
