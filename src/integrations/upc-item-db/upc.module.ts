import { Global, Module } from '@nestjs/common';

import { RateLimitingModule } from '@/modules/rate-limiting/rate-limiting.module';

import { UpcMapperService } from './upc-mapper.service';
import { UpcQuotaGuard } from './upc-quota.guard';
import { UpcItemDbService } from './upc.service';

/**
 * Wires the UPCitemdb stack: quota guard → mapper → API service.
 * Imports `RateLimitingModule` for `REDIS_QUOTA_PORT` — that module
 * is deliberately NOT global (see its own header comment), so any
 * consumer needing the port must import it explicitly.
 *
 * Exported globally itself (mirrors `OffModule`/`ObfModule`/
 * `OpfModule`) so `ProductProviderRegistryService` can consume
 * `UpcItemDbService` without `ProductsModule` needing to import this
 * module by name.
 */
@Global()
@Module({
  imports: [RateLimitingModule],
  providers: [UpcQuotaGuard, UpcMapperService, UpcItemDbService],
  exports: [UpcItemDbService],
})
export class UpcItemDbModule {}
