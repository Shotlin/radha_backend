import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ObservabilityModule } from '@/observability/observability.module';

import { SupplierContactsRepository } from './repositories/supplier-contacts.repository';
import { SuppliersRepository } from './repositories/suppliers.repository';
import { SupplierImportService } from './services/supplier-import.service';
import { SupplierPerformanceService } from './services/supplier-performance.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * BE-25 — Suppliers / vendor directory module.
 *
 * Imports:
 *   - AuthModule          → BE-08 guard stack + decorators.
 *   - ObservabilityModule → AuditLogService.
 *
 * Exported symbols (consumed by BE-26 GRN once it lands):
 *   - SuppliersService            — high-level CRUD + status flow.
 *   - SupplierPerformanceService  — record GRN-derived metrics.
 *   - SuppliersRepository         — for read-only joins from GRN.
 */
@Module({
  imports: [AuthModule, ObservabilityModule],
  controllers: [SuppliersController],
  providers: [
    SuppliersRepository,
    SupplierContactsRepository,
    SupplierPerformanceService,
    SupplierImportService,
    SuppliersService,
  ],
  exports: [
    SuppliersService,
    SupplierPerformanceService,
    SuppliersRepository,
    SupplierContactsRepository,
  ],
})
export class SuppliersModule {}
