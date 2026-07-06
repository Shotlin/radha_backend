import { Module } from '@nestjs/common';

import { HealthScoringModule } from '@/modules/health-scoring/health-scoring.module';
import { ProductsModule } from '@/modules/products/products.module';

import { CatalogImageHostService } from './catalog-image-host.service';
import { CatalogImportService } from './catalog-import.service';

/**
 * Catalog import module.
 *
 * Depends on both Products and HealthScoring (and the global OFF + AWS + Logger
 * modules). Nothing depends on it, so it adds no cycles. Wired into AppModule
 * purely so the catalog CLIs can resolve {@link CatalogImportService} and
 * {@link CatalogImageHostService} from a standalone application context.
 */
@Module({
  imports: [ProductsModule, HealthScoringModule],
  providers: [CatalogImportService, CatalogImageHostService],
  exports: [CatalogImportService, CatalogImageHostService],
})
export class CatalogImportModule {}
