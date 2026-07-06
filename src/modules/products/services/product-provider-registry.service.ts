import { Injectable, Optional } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import type {
  IProductDataProvider,
  ProductLookupHit,
} from '@/integrations/products/product-provider.types';
import { OpenBeautyFactsService } from '@/integrations/open-beauty-facts/obf.service';
import { OpenProductsFactsService } from '@/integrations/open-products-facts/opf.service';
import { UpcItemDbService } from '@/integrations/upc-item-db/upc.service';
import { ConfigService } from '@/config/config.service';

/**
 * Priority-ordered fallback chain tried AFTER Open Food Facts misses.
 *
 * Open Food Facts itself stays special-cased exactly as it is today in
 * `ProductLookupService` (untouched) — this registry only holds the
 * *additional* sources layered on top: Open Beauty Facts (cosmetics)
 * → Open Products Facts (household/general) → UPCitemdb (generic
 * last resort, tight quota). First hit wins; the caller persists it.
 *
 * Each provider is `@Optional()` so unit tests of `ProductLookupService`
 * don't need to stand up the entire integration stack, mirroring how
 * `OpenFoodFactsService` is already optional there. Each is also gated
 * by its own feature flag so any one can be switched off in prod
 * without a redeploy if it misbehaves.
 */
@Injectable()
export class ProductProviderRegistryService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigService,
    @Optional() private readonly obf?: OpenBeautyFactsService,
    @Optional() private readonly opf?: OpenProductsFactsService,
    @Optional() private readonly upc?: UpcItemDbService,
  ) {}

  private get providers(): IProductDataProvider[] {
    const flags = this.config.features;
    const list: IProductDataProvider[] = [];
    if (this.obf && flags.enableOpenBeautyFacts) list.push(this.obf);
    if (this.opf && flags.enableOpenProductsFacts) list.push(this.opf);
    if (this.upc && flags.enableUpcItemDb) list.push(this.upc);
    return list;
  }

  /**
   * Tries every enabled provider **concurrently** (not one-at-a-time) and
   * returns the first hit in priority order, or `null` if all miss.
   *
   * Was previously a sequential `for` loop awaiting each provider in turn.
   * Each provider already carries its own 5s wall-clock timeout, so a
   * genuine miss across all three (the common case for exactly the
   * regional/local products this fallback chain exists for) took up to
   * 15s — the dominant contributor to reports of scanning being "slow".
   * Firing them together bounds the wait to the slowest single provider
   * (~5s) instead of the sum. Priority order (OBF -> OPF -> UPC) is still
   * respected when picking which hit to trust, so behavior/data-source
   * precedence is unchanged — only the wall-clock cost of a miss drops.
   */
  async tryAll(ean: string): Promise<{ provider: IProductDataProvider; hit: ProductLookupHit } | null> {
    const providers = this.providers;
    if (providers.length === 0) return null;

    const settled = await Promise.allSettled(providers.map((provider) => provider.lookupByEan(ean)));

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const outcome = settled[i];
      if (outcome.status === 'rejected') {
        // A single provider's unexpected failure must not block the
        // remaining ones — each provider already catches its own
        // network/circuit-breaker errors internally, so reaching this
        // branch means something else went wrong (e.g. a mapper bug).
        this.logger.error('product_provider.registry.provider_threw', {
          ean,
          provider: provider.providerName,
          error: { name: (outcome.reason as Error)?.name, message: (outcome.reason as Error)?.message },
        });
        continue;
      }
      if (outcome.value) {
        this.logger.debug('product_provider.registry.hit', {
          ean,
          provider: provider.providerName,
        });
        return { provider, hit: outcome.value };
      }
    }
    return null;
  }
}
