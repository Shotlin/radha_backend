import { Module } from '@nestjs/common';

import { ObservabilityModule } from '@/observability/observability.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ProductsModule } from '@/modules/products/products.module';
import { SyncModule } from '@/modules/sync/sync.module';

import { ExpiryController } from './expiry.controller';
import { ExpiryService } from './expiry.service';
import { ExpiryAlertsRepository } from './repositories/expiry-alerts.repository';
import { ExpiryRecordsRepository } from './repositories/expiry-records.repository';
import { ExpiryThresholdsRepository } from './repositories/expiry-thresholds.repository';
import { ExpiryAlertService } from './services/expiry-alert.service';
import { ExpiryCalculatorService } from './services/expiry-calculator.service';
import { ExpiryThresholdService } from './services/expiry-threshold.service';
import { OcrDateValidatorService } from './services/ocr-date-validator.service';

/**
 * BE-18 — Expiry tracking module.
 *
 * Imports:
 *   - ProductsModule       → ProductsRepository for category lookup.
 *   - AuthModule           → BE-08 guard stack + decorators.
 *   - ObservabilityModule  → AuditLogService.
 *   - SyncModule           → IdempotencyService (BE-58 §B2.2: the
 *     app-wide `IdempotencyMiddleware` registered by SyncModule never
 *     actually applies here in practice — NestJS runs middleware BEFORE
 *     guards, so `req.user` isn't populated yet when that middleware
 *     runs on a `@UseGuards(JwtAuthGuard)`-protected route, and it
 *     silently skips idempotency without an authenticated user.
 *     Verified live: two identical `POST /expiry-records` calls with
 *     the same `Idempotency-Key` produced two different record ids.
 *     `createRecord` below applies idempotency explicitly instead,
 *     inside the guarded handler where `req.user`/`userId` is real.
 */
@Module({
  imports: [AuthModule, ProductsModule, ObservabilityModule, SyncModule],
  controllers: [ExpiryController],
  providers: [
    ExpiryRecordsRepository,
    ExpiryThresholdsRepository,
    ExpiryAlertsRepository,
    ExpiryCalculatorService,
    ExpiryThresholdService,
    ExpiryAlertService,
    OcrDateValidatorService,
    ExpiryService,
  ],
  exports: [
    ExpiryService,
    ExpiryAlertService,
    ExpiryCalculatorService,
    ExpiryThresholdService,
    ExpiryRecordsRepository,
    ExpiryAlertsRepository,
    ExpiryThresholdsRepository,
  ],
})
export class ExpiryModule {}
