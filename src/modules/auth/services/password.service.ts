import { Injectable } from '@nestjs/common';

import { ValidationException } from '@/common/errors/business.exception';

import { hashPassword, verifyPassword } from '../utils/password.utils';

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
  strength: 'weak' | 'medium' | 'strong' | 'very-strong';
  score: number;
}

const COMMON_PASSWORDS = new Set<string>([
  'password',
  'password123',
  'password1',
  'password!',
  '12345678',
  '123456789',
  'qwerty',
  'qwerty123',
  'abc123',
  'letmein',
  'admin',
  'welcome',
  'monkey',
  'admin@123',
  'india@123',
  'radha@123',
]);

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

/**
 * Password complexity validator + bcrypt wrapper.
 *
 * Splits responsibility: the policy lives here, the bcrypt cost is in
 * `password.utils.ts` so it's shared with the BE-07 token utilities
 * without re-importing this service.
 */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hashPassword(plain);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return verifyPassword(plain, hash);
  }

  validatePolicy(password: string): PasswordValidationResult {
    const errors: string[] = [];
    let score = 0;

    if (password.length < MIN_LENGTH) {
      errors.push(`Password must be at least ${MIN_LENGTH} characters.`);
    } else {
      score += 25;
      if (password.length >= 16) score += 10;
      if (password.length >= 20) score += 10;
    }
    if (password.length > MAX_LENGTH) {
      errors.push(`Password must not exceed ${MAX_LENGTH} characters.`);
    }

    const checks: Array<[RegExp, string, number]> = [
      [/[a-z]/, 'Must contain a lowercase letter.', 12],
      [/[A-Z]/, 'Must contain an uppercase letter.', 12],
      [/\d/, 'Must contain a number.', 12],
      [/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, 'Must contain a special character.', 14],
    ];
    for (const [re, message, weight] of checks) {
      if (re.test(password)) score += weight;
      else errors.push(message);
    }

    if (Array.from(COMMON_PASSWORDS).some((p) => password.toLowerCase().includes(p))) {
      errors.push('Password is too common.');
      score = Math.max(0, score - 30);
    }

    const uniqueChars = new Set(password).size;
    if (uniqueChars >= 8) score += 5;
    if (uniqueChars >= 12) score += 5;

    let strength: PasswordValidationResult['strength'];
    if (score < 40) strength = 'weak';
    else if (score < 60) strength = 'medium';
    else if (score < 85) strength = 'strong';
    else strength = 'very-strong';

    return {
      valid: errors.length === 0,
      errors,
      strength,
      score: Math.min(100, score),
    };
  }

  enforcePolicy(password: string, fieldName = 'password'): void {
    const result = this.validatePolicy(password);
    if (!result.valid) {
      throw new ValidationException('Password does not meet policy', {
        field: fieldName,
        metadata: { errors: result.errors, strength: result.strength, score: result.score },
      });
    }
  }
}
