import { Module, Provider } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { StoresModule } from '@/modules/stores/stores.module';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';

import { ClientDashboardController } from './client-dashboard.controller';
import { HealthScoresRepository } from './repositories/health-scores.repository';
import { AlertsSummaryService } from './services/alerts-summary.service';
import {
  ClientDashboardInventoryAccuracyAdapterService,
  ClientDashboardSubscriptionsAdapterService,
} from './services/client-dashboard-cross-module-adapters.service';
import { ComplianceCalculator } from './services/components/compliance.calculator';
import { ExpiryManagementCalculator } from './services/components/expiry-management.calculator';
import { InventoryAccuracyCalculator } from './services/components/inventory-accuracy.calculator';
import { TaskCompletionCalculator } from './services/components/task-completion.calculator';
import { TeamActivityCalculator } from './services/components/team-activity.calculator';
import { VendorQualityCalculator } from './services/components/vendor-quality.calculator';
import { ClientDashboardService } from './services/dashboard.service';
import { DashboardCacheService } from './services/dashboard-cache.service';
import { KpiService } from './services/kpi.service';
import { OperationalHealthScoreService } from './services/operational-health-score.service';
import { QuickActionService } from './services/quick-action.service';
import { TeamPerformanceService } from './services/team-performance.service';
import { TrendsService } from './services/trends.service';
import { DASHBOARD_CACHE_INVALIDATOR_TOKEN } from './types/dashboard.types';
import {
  INVENTORY_ACCURACY_METRICS_QUERY,
  SUBSCRIPTIONS_SERVICE_TOKEN,
} from './types/integration.tokens';

/**
 * BE-30 — Client Dashboard module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack + decorators.
 *   - StoresModule        → StoresRepository + StoreScopeGuard.
 *   - InventoryModule     → BE-27 InventoryAccuracyMetricsQuery.
 *   - SubscriptionsModule → BE-28 SubscriptionsService.
 *
 * Cross-phase contracts now wired to real BE-27 / BE-28 adapters:
 *   - `INVENTORY_ACCURACY_METRICS_QUERY` → ClientDashboardInventoryAccuracyAdapterService.
 *   - `SUBSCRIPTIONS_SERVICE_TOKEN`      → ClientDashboardSubscriptionsAdapterService.
 *
 * Cache invalidator export:
 *   - `DASHBOARD_CACHE_INVALIDATOR_TOKEN` is bound to the
 *     `DashboardCacheService` so other modules (scans / expiry /
 *     tasks repositories) can call `invalidateStore(...)` without
 *     reaching back into this module's source.
 */

const inventoryAccuracyProvider: Provider = {
  provide: INVENTORY_ACCURACY_METRICS_QUERY,
  useExisting: ClientDashboardInventoryAccuracyAdapterService,
};

const subscriptionsProvider: Provider = {
  provide: SUBSCRIPTIONS_SERVICE_TOKEN,
  useExisting: ClientDashboardSubscriptionsAdapterService,
};

const cacheInvalidatorProvider: Provider = {
  provide: DASHBOARD_CACHE_INVALIDATOR_TOKEN,
  useExisting: DashboardCacheService,
};

@Module({
  imports: [AuthModule, StoresModule, InventoryModule, SubscriptionsModule],
  controllers: [ClientDashboardController],
  providers: [
    /* Sub-services */
    KpiService,
    AlertsSummaryService,
    QuickActionService,
    TrendsService,
    TeamPerformanceService,
    DashboardCacheService,

    /* OHS calculators + service + repo */
    ComplianceCalculator,
    ExpiryManagementCalculator,
    InventoryAccuracyCalculator,
    TaskCompletionCalculator,
    TeamActivityCalculator,
    VendorQualityCalculator,
    OperationalHealthScoreService,
    HealthScoresRepository,

    /* Real adapters + token bindings */
    ClientDashboardInventoryAccuracyAdapterService,
    ClientDashboardSubscriptionsAdapterService,
    inventoryAccuracyProvider,
    subscriptionsProvider,

    /* Cache invalidator binding for downstream modules */
    cacheInvalidatorProvider,

    /* Public façade */
    ClientDashboardService,
  ],
  exports: [
    ClientDashboardService,
    OperationalHealthScoreService,
    HealthScoresRepository,
    DashboardCacheService,
    cacheInvalidatorProvider,
  ],
})
export class ClientDashboardModule {}
