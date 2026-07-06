import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * BE-37 — Mock KMS encryption service.
 *
 * Uses AES-256-GCM for envelope encryption of display names.
 * In production this would delegate to AWS KMS or a vault;
 * for now the key is derived from an env var or a static fallback.
 *
 * Ciphertext format: iv(12) + authTag(16) + ciphertext
 */
@Injectable()
export class AllergenEncryptionService {
  private readonly key: Buffer;

  constructor() {
    const envKey = process.env.ALLERGEN_ENCRYPTION_KEY;
    if (envKey && Buffer.from(envKey, 'hex').length === 32) {
      this.key = Buffer.from(envKey, 'hex');
    } else {
      // Static fallback for development — 32 bytes (AES-256)
      this.key = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
    }
  }

  /**
   * Encrypt plaintext to a base64-encoded envelope.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope = Buffer.concat([iv, authTag, encrypted]);
    return envelope.toString('base64');
  }

  /**
   * Decrypt a base64-encoded envelope back to plaintext.
   */
  decrypt(ciphertext: string): string {
    const envelope = Buffer.from(ciphertext, 'base64');
    const iv = envelope.subarray(0, 12);
    const authTag = envelope.subarray(12, 28);
    const encrypted = envelope.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
