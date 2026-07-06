import { Module } from '@nestjs/common';

import { ObservabilityModule } from '@/observability/observability.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ProductsModule } from '@/modules/products/products.module';

import { EanListsController } from './ean-lists.controller';
import { EanListsService } from './ean-lists.service';
import { EanListItemsRepository } from './repositories/ean-list-items.repository';
import { EanListsRepository } from './repositories/ean-lists.repository';
import { ImportBatchesRepository } from './repositories/import-batches.repository';
import { ImportErrorsRepository } from './repositories/import-errors.repository';
import { CsvParserService } from './services/csv-parser.service';
import { EanMatcherService } from './services/ean-matcher.service';
import { ExcelParserService } from './services/excel-parser.service';
import { ImportProcessorService } from './services/import-processor.service';

/**
 * BE-15 — EAN list management module.
 *
 * Imports `ProductsModule` to consume `ProductsRepository` for
 * import-time EAN→productId resolution. `AuthModule` is required
 * because the controller uses the BE-08 guard stack and decorators.
 * `ObservabilityModule` provides `AuditLogService`.
 */
@Module({
  imports: [AuthModule, ProductsModule, ObservabilityModule],
  controllers: [EanListsController],
  providers: [
    EanListsService,
    EanListsRepository,
    EanListItemsRepository,
    ImportBatchesRepository,
    ImportErrorsRepository,
    ExcelParserService,
    CsvParserService,
    ImportProcessorService,
    EanMatcherService,
  ],
  exports: [EanListsService, EanMatcherService, EanListsRepository, EanListItemsRepository],
})
export class EanListsModule {}
