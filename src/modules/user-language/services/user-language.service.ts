import { Injectable, NotFoundException } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { UsersRepository } from '@/modules/auth/repositories/users.repository';

import type { SupportedLocale } from '@/common/i18n/types/locale.types';

import type { UpdateLanguageResponseDto } from '../dto/update-language.dto';

/**
 * BE-42 — User language preference service.
 *
 * Persists the authenticated user's `preferred_language` choice and
 * reports back whether the value actually changed. The PUT semantics
 * are idempotent — re-submitting the current language is a no-op.
 *
 * Validation of the locale itself happens in the DTO via Zod, so by
 * the time the service runs we can trust the input is one of the
 * six supported codes.
 */
@Injectable()
export class UserLanguageService {
  constructor(
    private readonly users: UsersRepository,
    private readonly logger: LoggerService,
  ) {}

  async updatePreferredLanguage(
    userId: string,
    language: SupportedLocale,
  ): Promise<UpdateLanguageResponseDto> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const current = (user as { preferredLanguage?: string }).preferredLanguage ?? 'en';
    if (current === language) {
      return { preferredLanguage: current, changed: false };
    }

    await this.users.update(userId, {
      preferredLanguage: language,
    } as never);

    this.logger.info('user_language.updated', {
      userId,
      previous: current,
      next: language,
    });

    return { preferredLanguage: language, changed: true };
  }
}
