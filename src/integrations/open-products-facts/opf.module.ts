import { Global, Module } from '@nestjs/common';

import { OpfCacheRepository } from './opf-cache.repository';
import { OpfCacheService } from './opf-cache.service';
import { OpfMapperService } from './opf-mapper.service';
import { OpenProductsFactsService } from './opf.service';

/**
 * Wires the Open Products Facts stack: cache repo → cache service →
 * API service → mapper. Exported globally (mirrors `OffModule` /
 * `ObfModule`).
 */
@Global()
@Module({
  providers: [OpfCacheRepository, OpfCacheService, OpfMapperService, OpenProductsFactsService],
  exports: [OpfCacheService, OpfMapperService, OpenProductsFactsService],
})
export class OpfModule {}
