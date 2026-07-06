import { createHash, randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';

const PASSWORD_BCRYPT_ROUNDS = 12;
const TOKEN_BYTES = 48;

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, PASSWORD_BCRYPT_ROUNDS);

export const verifyPassword = async (plain: string, hash: string): Promise<boolean> => {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
};

/**
 * Generates an opaque secret (URL-safe base64). Used for password-reset,
 * email-verification, and admin-invitation tokens. Plaintext is given to
 * the user; only the sha256 hash is stored server-side.
 */
export const generateOpaqueToken = (): { plaintext: string; hash: string } => {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
};

export const hashOpaqueToken = (plaintext: string): string =>
  createHash('sha256').update(plaintext).digest('hex');
