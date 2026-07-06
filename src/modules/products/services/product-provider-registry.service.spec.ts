import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import type { IProductDataProvider, ProductLookupHit } from '@/integrations/products/product-provider.types';
import { OpenBeautyFactsService } from '@/integrations/open-beauty-facts/obf.service';
import { OpenProductsFactsService } from '@/integrations/open-products-facts/opf.service';
import { UpcItemDbService } from '@/integrations/upc-item-db/upc.service';

import { ProductProviderRegistryService } from './product-provider-registry.service';

/**
 * `tryAll()` used to await each provider one-at-a-time; a genuine miss
 * across all three (the common case for products this fallback chain
 * exists for) took up to 15s. These tests lock in the concurrent
 * replacement: all enabled providers are queried together, priority
 * order still decides which hit wins, and one provider's failure never
 * blocks the others.
 */
describe('ProductProviderRegistryService', () => {
  const EAN = '8906112662414';

  function makeHit(name: ProductLookupHit['mapped']['dataSource']): ProductLookupHit {
    return {
      mapped: { ean: EAN, name: `Product from ${name}`, dataSource: name, externalId: EAN },
      nutrition: null,
    };
  }

  function makeProvider(
    name: IProductDataProvider['providerName'],
    impl: (ean: string) => Promise<ProductLookupHit | null>,
  ): IProductDataProvider {
    return {
      providerName: name,
      lookupByEan: jest.fn(impl),
      isHealthy: jest.fn().mockResolvedValue(true),
    };
  }

  function makeService(opts: {
    obf?: IProductDataProvider;
    opf?: IProductDataProvider;
    upc?: IProductDataProvider;
    flags?: Partial<Record<'enableOpenBeautyFacts' | 'enableOpenProductsFacts' | 'enableUpcItemDb', boolean>>;
  }) {
    const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;
    const config = {
      features: {
        enableOpenBeautyFacts: opts.flags?.enableOpenBeautyFacts ?? true,
        enableOpenProductsFacts: opts.flags?.enableOpenProductsFacts ?? true,
        enableUpcItemDb: opts.flags?.enableUpcItemDb ?? true,
      },
    } as unknown as ConfigService;

    return new ProductProviderRegistryService(
      logger,
      config,
      opts.obf as OpenBeautyFactsService,
      opts.opf as OpenProductsFactsService,
      opts.upc as UpcItemDbService,
    );
  }

  it('queries every enabled provider concurrently, not one-at-a-time', async () => {
    let obfInFlightWhenOpfCalled = false;
    let obfResolved = false;

    const obf = makeProvider('open_beauty_facts', async () => {
      await new Promise((r) => setTimeout(r, 20));
      obfResolved = true;
      return null;
    });
    const opf = makeProvider('open_products_facts', async () => {
      // If tryAll were still sequential, OBF's 20ms delay would have
      // already resolved by the time OPF is even called.
      obfInFlightWhenOpfCalled = !obfResolved;
      return null;
    });

    const service = makeService({ obf, opf });
    await service.tryAll(EAN);

    expect(obfInFlightWhenOpfCalled).toBe(true);
    expect(obf.lookupByEan).toHaveBeenCalledWith(EAN);
    expect(opf.lookupByEan).toHaveBeenCalledWith(EAN);
  });

  it('prefers the higher-priority provider hit even when a lower-priority one resolves first', async () => {
    const obf = makeProvider('open_beauty_facts', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return makeHit('open_beauty_facts');
    });
    const opf = makeProvider('open_products_facts', async () => makeHit('open_products_facts'));

    const service = makeService({ obf, opf });
    const result = await service.tryAll(EAN);

    expect(result?.provider.providerName).toBe('open_beauty_facts');
  });

  it("falls through to the next provider's hit when a higher-priority one misses", async () => {
    const obf = makeProvider('open_beauty_facts', async () => null);
    const opf = makeProvider('open_products_facts', async () => makeHit('open_products_facts'));

    const service = makeService({ obf, opf });
    const result = await service.tryAll(EAN);

    expect(result?.provider.providerName).toBe('open_products_facts');
  });

  it("one provider's rejection does not block a later provider's hit", async () => {
    const obf = makeProvider('open_beauty_facts', async () => {
      throw new Error('boom');
    });
    const opf = makeProvider('open_products_facts', async () => makeHit('open_products_facts'));

    const service = makeService({ obf, opf });
    const result = await service.tryAll(EAN);

    expect(result?.provider.providerName).toBe('open_products_facts');
  });

  it('returns null when every provider misses', async () => {
    const obf = makeProvider('open_beauty_facts', async () => null);
    const upc = makeProvider('upc_item_db', async () => null);

    const service = makeService({ obf, upc });
    const result = await service.tryAll(EAN);

    expect(result).toBeNull();
  });

  it('returns null immediately with no providers enabled', async () => {
    const service = makeService({ flags: { enableOpenBeautyFacts: false, enableOpenProductsFacts: false, enableUpcItemDb: false } });
    const result = await service.tryAll(EAN);

    expect(result).toBeNull();
  });
});
