import { Module } from '@nestjs/common';

import { ObservabilityModule } from '@/observability/observability.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ProductsModule } from '@/modules/products/products.module';

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
 */
@Module({
  imports: [AuthModule, ProductsModule, ObservabilityModule],
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
