import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { ExpiryCalendarController } from './controllers/expiry-calendar.controller';
import { ExpiryCalendarRepository } from './expiry-calendar.repository';
import { FamilySharingRepository } from './repositories/family-sharing-lookup.repository';
import { ExpiryCalendarService } from './services/expiry-calendar.service';

/**
 * BE-38 — Expiry Calendar (Consumer) module.
 *
 * Provides calendar-view of saved products with expiry color-coding.
 * Premium consumers see union with family sharing members.
 */
@Module({
  imports: [AuthModule],
  controllers: [ExpiryCalendarController],
  providers: [ExpiryCalendarService, ExpiryCalendarRepository, FamilySharingRepository],
  exports: [ExpiryCalendarService],
})
export class ExpiryCalendarModule {}
