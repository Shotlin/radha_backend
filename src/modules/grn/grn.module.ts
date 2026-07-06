import { Module, Provider } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ExpiryModule } from '@/modules/expiry/expiry.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { ProductsModule } from '@/modules/products/products.module';
import { SuppliersModule } from '@/modules/suppliers/suppliers.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { GrnController } from './grn.controller';
import { GrnService } from './grn.service';
import { GrnEventsRepository } from './repositories/grn-events.repository';
import { GrnHeadersRepository } from './repositories/grn-headers.repository';
import { GrnItemsRepository } from './repositories/grn-items.repository';
import { GrnPostingService } from './services/grn-posting.service';
import { GrnReversalService } from './services/grn-reversal.service';
import { GrnValidationService } from './services/grn-validation.service';
import {
  GrnSupplierLookupAdapterService,
  GrnSupplierPerfAdapterService,
} from './services/grn-cross-module-adapters.service';
import {
  INVENTORY_SERVICE_TOKEN,
  SUPPLIER_LOOKUP_TOKEN,
  SUPPLIER_PERFORMANCE_TOKEN,
} from './types/grn.types';
import { GrnNumberGenerator } from './utils/grn-number-generator.utils';

/**
 * BE-26 — GRN module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack + decorators.
 *   - ProductsModule      → ProductsRepository (catalog read / auto-create).
 *   - ExpiryModule        → ExpiryService (BE-18 batch registration).
 *   - InventoryModule     → BE-27 InventoryService (real stock-in/out).
 *   - SuppliersModule     → BE-25 SuppliersRepository + SupplierPerformanceService.
 *   - ObservabilityModule → AuditLogService.
 *
 * Cross-phase contracts (previously wired to in-process stubs; now
 * bound to the real BE-25 / BE-27 implementations):
 *   - `INVENTORY_SERVICE_TOKEN`     → InventoryService (BE-27).
 *   - `SUPPLIER_LOOKUP_TOKEN`       → GrnSupplierLookupAdapterService.
 *   - `SUPPLIER_PERFORMANCE_TOKEN`  → GrnSupplierPerfAdapterService.
 *
 * Exports:
 *   - GrnService       — used by BE-31 dashboard reads.
 *   - GrnPostingService / GrnReversalService — used by App Owner
 *                       Dashboard direct controls.
 *   - The three repositories — used by BE-30 OHS analytics read
 *                       the raw rows.
 */

const inventoryProvider: Provider = {
  provide: INVENTORY_SERVICE_TOKEN,
  useExisting: InventoryService,
};

const supplierLookupProvider: Provider = {
  provide: SUPPLIER_LOOKUP_TOKEN,
  useExisting: GrnSupplierLookupAdapterService,
};

const supplierPerfProvider: Provider = {
  provide: SUPPLIER_PERFORMANCE_TOKEN,
  useExisting: GrnSupplierPerfAdapterService,
};

@Module({
  imports: [AuthModule, ProductsModule, ExpiryModule, InventoryModule, SuppliersModule, ObservabilityModule],
  controllers: [GrnController],
  providers: [
    GrnHeadersRepository,
    GrnItemsRepository,
    GrnEventsRepository,

    GrnNumberGenerator,
    GrnValidationService,
    GrnPostingService,
    GrnReversalService,

    GrnSupplierLookupAdapterService,
    GrnSupplierPerfAdapterService,

    inventoryProvider,
    supplierLookupProvider,
    supplierPerfProvider,

    GrnService,
  ],
  exports: [
    GrnService,
    GrnPostingService,
    GrnReversalService,
    GrnHeadersRepository,
    GrnItemsRepository,
    GrnEventsRepository,
  ],
})
export class GrnModule {}
