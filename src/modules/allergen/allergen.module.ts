import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { AllergenController } from './controllers/allergen.controller';
import { AllergenProfileRepository } from './repositories/allergen-profile.repository';
import { AllergenMatcherService } from './services/allergen-matcher.service';
import { AllergenProfileService } from './services/allergen-profile.service';
import { AllergenEncryptionService } from './services/encryption.service';

/**
 * BE-37 — Allergen module.
 *
 * Provides per-family-member allergen profiles with:
 *   - Plan-based quota enforcement (Free=1, Premium=5)
 *   - AES-256-GCM encryption of display names
 *   - Allergen matching with synonym support
 *
 * Exports AllergenProfileService and AllergenMatcherService
 * for use by BE-12 (comprehensive health scoring).
 */
@Module({
  imports: [AuthModule],
  controllers: [AllergenController],
  providers: [
    AllergenProfileRepository,
    AllergenEncryptionService,
    AllergenMatcherService,
    AllergenProfileService,
  ],
  exports: [AllergenProfileService, AllergenMatcherService],
})
export class AllergenModule {}
