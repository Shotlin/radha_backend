import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ProductsModule } from '@/modules/products/products.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryAccuracyMetricsQuery } from './queries/inventory-accuracy-metrics.query';
import { InventoryBatchesRepository } from './repositories/inventory-batches.repository';
import { InventoryItemsRepository } from './repositories/inventory-items.repository';
import { LowStockAlertsRepository } from './repositories/low-stock-alerts.repository';
import { LowStockRulesRepository } from './repositories/low-stock-rules.repository';
import { StockCountLinesRepository } from './repositories/stock-count-lines.repository';
import { StockCountsRepository } from './repositories/stock-counts.repository';
import { StockMovementsRepository } from './repositories/stock-movements.repository';
import { InventoryAggregatorService } from './services/inventory-aggregator.service';
import { LowStockAlertService } from './services/low-stock-alert.service';
import { StockCountService } from './services/stock-count.service';
import { StockMovementService } from './services/stock-movement.service';

/**
 * BE-27 — Inventory module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack + decorators.
 *   - ProductsModule      → ProductsRepository (used by alert service
 *                           to resolve product names for notification
 *                           bodies).
 *   - NotificationsModule → BE-24 NotificationsService for low-stock
 *                           alert fan-out.
 *   - ObservabilityModule → AuditLogService.
 *
 * Exports:
 *   - InventoryService                  — public façade + GRN
 *                                         `IInventoryService` impl.
 *                                         The orchestrator binds this
 *                                         to BE-26's
 *                                         `INVENTORY_SERVICE_TOKEN`.
 *   - StockMovementService              — used by BE-30 OHS (movement
 *                                         volume signal).
 *   - InventoryAccuracyMetricsQuery     — v2 ADDENDUM read-side for
 *                                         BE-30 OHS.
 *   - All repositories                  — BE-30 OHS analytics read
 *                                         the raw rows.
 */
@Module({
  imports: [AuthModule, ProductsModule, NotificationsModule, ObservabilityModule],
  controllers: [InventoryController],
  providers: [
    /* Repositories */
    InventoryItemsRepository,
    InventoryBatchesRepository,
    StockMovementsRepository,
    LowStockRulesRepository,
    LowStockAlertsRepository,
    StockCountsRepository,
    StockCountLinesRepository,

    /* Sub-services */
    LowStockAlertService,
    StockMovementService,
    StockCountService,
    InventoryAggregatorService,

    /* v2 ADDENDUM read-side for BE-30 */
    InventoryAccuracyMetricsQuery,

    /* Public facade */
    InventoryService,
  ],
  exports: [
    InventoryService,
    StockMovementService,
    LowStockAlertService,
    InventoryAggregatorService,
    InventoryAccuracyMetricsQuery,
    InventoryItemsRepository,
    InventoryBatchesRepository,
    StockMovementsRepository,
    LowStockAlertsRepository,
    LowStockRulesRepository,
    StockCountsRepository,
    StockCountLinesRepository,
  ],
})
export class InventoryModule {}
