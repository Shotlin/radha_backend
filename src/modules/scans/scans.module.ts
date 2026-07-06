import { Module } from '@nestjs/common';

import { ObservabilityModule } from '@/observability/observability.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { EanListsModule } from '@/modules/ean-lists/ean-lists.module';
import { ProductsModule } from '@/modules/products/products.module';

import { ScanItemsRepository } from './repositories/scan-items.repository';
import { ScanSessionsRepository } from './repositories/scan-sessions.repository';
import { ScanSyncBatchesRepository } from './repositories/scan-sync-batches.repository';
import { ScansController } from './scans.controller';
import { BulkScanService } from './services/bulk-scan.service';
import { DuplicateDetectorService } from './services/duplicate-detector.service';
import { IdempotencyService } from './services/idempotency.service';
import { ScanItemService } from './services/scan-item.service';
import { ScanSessionService } from './services/scan-session.service';
import { ScanSummaryService } from './services/scan-summary.service';

/**
 * BE-16 + BE-17 — Scan Session module + Bulk Sync.
 *
 * Pulls in:
 *   - ProductsModule    → ProductLookupService for the EAN→Product hop
 *   - EanListsModule    → EanMatcherService for list validation
 *   - ObservabilityModule → AuditLogService
 *   - AuthModule        → BE-08 guard stack + decorators
 */
@Module({
  imports: [AuthModule, ProductsModule, EanListsModule, ObservabilityModule],
  controllers: [ScansController],
  providers: [
    ScanSessionsRepository,
    ScanItemsRepository,
    ScanSyncBatchesRepository,
    DuplicateDetectorService,
    ScanSummaryService,
    ScanSessionService,
    ScanItemService,
    IdempotencyService,
    BulkScanService,
  ],
  exports: [
    ScanSessionsRepository,
    ScanItemsRepository,
    ScanSyncBatchesRepository,
    ScanSessionService,
    ScanItemService,
    ScanSummaryService,
    BulkScanService,
    IdempotencyService,
  ],
})
export class ScansModule {}
