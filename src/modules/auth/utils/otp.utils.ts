import { randomInt } from 'node:crypto';

import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

/**
 * Generates a numeric OTP of the requested length using
 * `crypto.randomInt` (cryptographically secure, no Math.random).
 */
export const generateOtp = (length = 6): string => {
  if (length < 4 || length > 8) {
    throw new Error(`OTP length must be 4..8, got ${length}`);
  }
  const min = 10 ** (length - 1);
  const max = 10 ** length;
  return String(randomInt(min, max));
};

/** Constant-time bcrypt hash; suitable for short-lived OTPs. */
export const hashOtp = (otp: string): Promise<string> => bcrypt.hash(otp, BCRYPT_ROUNDS);

/**
 * Constant-time comparison via bcrypt.compare. Always resolves —
 * a thrown error inside bcrypt is treated as "did not match".
 */
export const verifyOtp = async (plain: string, hash: string): Promise<boolean> => {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
};
