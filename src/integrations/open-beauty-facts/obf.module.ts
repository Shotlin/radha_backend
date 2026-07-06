import { Global, Module } from '@nestjs/common';

import { ObfCacheRepository } from './obf-cache.repository';
import { ObfCacheService } from './obf-cache.service';
import { ObfMapperService } from './obf-mapper.service';
import { OpenBeautyFactsService } from './obf.service';

/**
 * Wires the Open Beauty Facts stack: cache repo → cache service →
 * API service → mapper. Exported globally (mirrors `OffModule`) so
 * `ProductProviderRegistryService` can consume it without every
 * importing module needing to know about it explicitly.
 */
@Global()
@Module({
  providers: [ObfCacheRepository, ObfCacheService, ObfMapperService, OpenBeautyFactsService],
  exports: [ObfCacheService, ObfMapperService, OpenBeautyFactsService],
})
export class ObfModule {}
