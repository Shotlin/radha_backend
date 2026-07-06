import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { FamilyController } from './family.controller';
import { FamilyRepository } from './family.repository';
import { FamilyService } from './family.service';

/**
 * BE-36 — Family Sharing module.
 *
 * Implements the consumer-facing family sharing feature: a Premium
 * Consumer subscriber can invite up to 5 family members by mobile
 * number, granting them derived subscription entitlements.
 */
@Module({
  imports: [AuthModule],
  controllers: [FamilyController],
  providers: [FamilyRepository, FamilyService],
})
export class FamilyModule {}
