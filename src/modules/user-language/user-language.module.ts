import { Module } from '@nestjs/common';

import { I18nModule } from '@/common/i18n/i18n.module';
import { AuthModule } from '@/modules/auth/auth.module';

import { UserLanguageController } from './controllers/user-language.controller';
import { UserLanguageService } from './services/user-language.service';

/**
 * BE-42 — User-language preference module.
 *
 * Owns the `PUT /api/v1/users/me/language` endpoint that persists
 * the authenticated user's preferred language on the `users` row.
 *
 * Imports:
 *   - `AuthModule`  → JwtAuthGuard + UsersRepository.
 *   - `I18nModule`  → not strictly required for the persistence call,
 *                     but kept here so any future localised response
 *                     (e.g. confirmation message) can inject `I18nService`.
 *
 * NOTE: per the implementation brief, this module is registered by
 * its consumer — `app.module.ts` is intentionally not modified here.
 */
@Module({
  imports: [AuthModule, I18nModule],
  controllers: [UserLanguageController],
  providers: [UserLanguageService],
  exports: [UserLanguageService],
})
export class UserLanguageModule {}
