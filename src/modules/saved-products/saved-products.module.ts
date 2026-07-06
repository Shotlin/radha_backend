import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { RateLimitingModule } from '@/modules/rate-limiting/rate-limiting.module';

import { SavedProductsController } from './saved-products.controller';
import { SavedProductsRepository } from './saved-products.repository';
import { SavedProductsService } from './saved-products.service';

/**
 * Saved Products module — REST surface for the FE-16 mobile screen.
 *
 * Wires:
 *   - `SavedProductsController`  → `/api/v1/saved-products/*`
 *   - `SavedProductsService`     → business logic + DTO mapping
 *   - `SavedProductsRepository`  → Drizzle queries (user-scoped)
 *
 * Imports:
 *   - `AuthModule`         provides `JwtAuthGuard`
 *   - `RateLimitingModule` provides `QuotaGuard` + the `save`
 *                          counter consumed by the `POST` route
 *
 * Leaf module — exports nothing because no other domain needs to
 * call into saved products' service today. The sync envelope at
 * `/api/v1/sync/saved-products` is owned separately (Agent A) and
 * does not consume this module.
 */
@Module({
  imports: [AuthModule, RateLimitingModule],
  controllers: [SavedProductsController],
  providers: [SavedProductsRepository, SavedProductsService],
})
export class SavedProductsModule {}
