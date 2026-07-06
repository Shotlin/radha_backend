import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { HealthScoringModule } from '@/modules/health-scoring/health-scoring.module';

import { ConsumerCatalogController } from './controllers/consumer-catalog.controller';
import { ScanController } from './controllers/scan.controller';
import { SearchController } from './controllers/search.controller';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';
import { ConsumerCatalogRepository } from './repositories/consumer-catalog.repository';
import { ProductCategoriesRepository } from './repositories/product-categories.repository';
import { ProductNutritionRepository } from './repositories/product-nutrition.repository';
import { SearchRepository } from './repositories/search.repository';
import { ConsumerCatalogService } from './services/consumer-catalog.service';
import { ProductLookupService } from './services/product-lookup.service';
import { ProductProviderRegistryService } from './services/product-provider-registry.service';
import { ProductSearchService } from './services/product-search.service';
import { ScanModePreferenceService } from './services/scan-mode-preference.service';
import { SearchAnalyticsService } from './services/search-analytics.service';

@Module({
  imports: [AuthModule, forwardRef(() => HealthScoringModule)],
  controllers: [ProductsController, ScanController, SearchController, ConsumerCatalogController],
  providers: [
    ProductsRepository,
    ProductNutritionRepository,
    SearchRepository,
    ConsumerCatalogRepository,
    ProductCategoriesRepository,
    ProductsService,
    ProductLookupService,
    ProductProviderRegistryService,
    ProductSearchService,
    SearchAnalyticsService,
    ScanModePreferenceService,
    ConsumerCatalogService,
  ],
  exports: [
    ProductsRepository,
    ProductNutritionRepository,
    SearchRepository,
    ConsumerCatalogRepository,
    ProductCategoriesRepository,
    ProductsService,
    ProductLookupService,
    ProductProviderRegistryService,
    ProductSearchService,
    SearchAnalyticsService,
    ScanModePreferenceService,
    ConsumerCatalogService,
  ],
})
export class ProductsModule {}
