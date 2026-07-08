import { ValidationException } from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';

import type { ProductRow } from '@/db/schema/products';
import type { DbService } from '@/db/db.service';
import type { IProductDataProvider } from '@/integrations/products/product-provider.types';

import { ProductsRepository } from '../products.repository';
import { ProductNutritionRepository } from '../repositories/product-nutrition.repository';
import { ProductLookupService } from '../services/product-lookup.service';
import { ProductProviderRegistryService } from '../services/product-provider-registry.service';

const buildSvc = (
  options: {
    findVisibleByEan?: jest.Mock;
    findManyByEans?: jest.Mock;
    findByProductId?: jest.Mock;
    db?: { transaction: jest.Mock };
    registry?: { tryAll: jest.Mock };
  } = {},
): {
  svc: ProductLookupService;
  products: jest.Mocked<ProductsRepository>;
  registry: { tryAll: jest.Mock };
} => {
  const products = {
    findVisibleByEan: options.findVisibleByEan ?? jest.fn().mockResolvedValue(null),
    findManyByEans: options.findManyByEans ?? jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ProductsRepository>;
  const nutrition = {
    findByProductId: options.findByProductId ?? jest.fn().mockResolvedValue(null),
  } as unknown as ProductNutritionRepository;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
  const db = (options.db ?? { transaction: jest.fn() }) as unknown as DbService;
  const registry = (options.registry ?? {
    tryAll: jest.fn().mockResolvedValue(null),
  }) as unknown as ProductProviderRegistryService & { tryAll: jest.Mock };
  return {
    svc: new ProductLookupService(products, nutrition, logger, db, undefined, undefined, registry),
    products,
    registry: registry as unknown as { tryAll: jest.Mock },
  };
};

describe('ProductLookupService.lookupByEan', () => {
  it('throws ValidationException for malformed EAN', async () => {
    const { svc } = buildSvc();
    await expect(svc.lookupByEan('abc', null)).rejects.toBeInstanceOf(ValidationException);
  });

  it('returns found=false when nothing visible to the tenant', async () => {
    const { svc } = buildSvc();
    const result = await svc.lookupByEan('4006381333931', 't-1');
    expect(result.found).toBe(false);
    expect(result.source).toBe('unknown');
  });

  it('returns found=true with database source on hit', async () => {
    const product = {
      id: 'p-1',
      ean: '4006381333931',
      tenantId: 't-1',
      dataSource: 'manual',
    } as ProductRow;
    const { svc, products } = buildSvc({
      findVisibleByEan: jest.fn().mockResolvedValue(product),
    });
    const result = await svc.lookupByEan('4006381333931', 't-1');
    expect(result.found).toBe(true);
    expect(result.source).toBe('database');
    expect(products.findVisibleByEan).toHaveBeenCalledWith('4006381333931', 't-1');
  });

  it('reports source open-food-facts when dataSource matches', async () => {
    const product = {
      id: 'p-2',
      ean: '4006381333931',
      tenantId: null,
      dataSource: 'open_food_facts',
    } as ProductRow;
    const { svc } = buildSvc({
      findVisibleByEan: jest.fn().mockResolvedValue(product),
    });
    const result = await svc.lookupByEan('4006381333931', null);
    expect(result.source).toBe('open-food-facts');
  });

  it.each([
    ['open_beauty_facts', 'open-beauty-facts'],
    ['open_products_facts', 'open-products-facts'],
    ['upc_item_db', 'upc-item-db'],
  ])('reports source %s as %s when a DB hit carries that dataSource', async (dataSource, expected) => {
    const product = {
      id: 'p-3',
      ean: '4006381333931',
      tenantId: null,
      dataSource,
    } as ProductRow;
    const { svc } = buildSvc({
      findVisibleByEan: jest.fn().mockResolvedValue(product),
    });
    const result = await svc.lookupByEan('4006381333931', null);
    expect(result.source).toBe(expected);
  });
});

describe('ProductLookupService multi-provider registry branch (additive on top of OFF)', () => {
  function fakeTx(productsRow: ProductRow | undefined) {
    const productsChain = {
      values: jest.fn().mockReturnThis(),
      onConflictDoNothing: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue(productsRow ? [productsRow] : []),
    };
    const nutritionChain = {
      values: jest.fn().mockReturnThis(),
      onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    };
    let call = 0;
    const insert = jest.fn(() => (call++ === 0 ? productsChain : nutritionChain));
    return { insert };
  }

  it('tries the registry on a DB miss (no OFF injected) and persists the hit', async () => {
    const insertedRow = {
      id: 'p-4',
      ean: '4006381333931',
      tenantId: null,
      dataSource: 'open_beauty_facts',
    } as ProductRow;
    const db = { transaction: jest.fn((cb) => cb(fakeTx(insertedRow))) };
    const obfProvider = { providerName: 'open_beauty_facts' } as IProductDataProvider;
    const registry = {
      tryAll: jest.fn().mockResolvedValue({
        provider: obfProvider,
        hit: {
          mapped: {
            ean: '4006381333931',
            name: 'Soap',
            dataSource: 'open_beauty_facts',
            externalId: '4006381333931',
          },
          nutrition: null,
        },
      }),
    };
    const { svc } = buildSvc({ db, registry });

    const result = await svc.lookupByEan('4006381333931', null);

    expect(registry.tryAll).toHaveBeenCalledWith('4006381333931');
    expect(result.found).toBe(true);
    expect(result.source).toBe('open-beauty-facts');
    expect(result.externalApiCalled).toBe(true);
  });

  it('returns found=false when the registry also misses', async () => {
    const { svc, registry } = buildSvc();

    const result = await svc.lookupByEan('4006381333931', null);

    expect(registry.tryAll).toHaveBeenCalled();
    expect(result.found).toBe(false);
  });

  it('still works with no registry injected at all (it is @Optional())', async () => {
    const products = {
      findVisibleByEan: jest.fn().mockResolvedValue(null),
      findManyByEans: jest.fn().mockResolvedValue([]),
    } as unknown as ProductsRepository;
    const nutrition = {
      findByProductId: jest.fn().mockResolvedValue(null),
    } as unknown as ProductNutritionRepository;
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;
    const svc = new ProductLookupService(
      products,
      nutrition,
      logger,
      {} as unknown as DbService,
    );

    const result = await svc.lookupByEan('4006381333931', null);

    expect(result.found).toBe(false);
  });
});

describe('ProductLookupService.lookupBatch', () => {
  it('mixes valid hit, valid miss, and invalid input correctly', async () => {
    const product = {
      id: 'p-1',
      ean: '4006381333931',
      tenantId: 't-1',
      dataSource: 'manual',
    } as ProductRow;
    const { svc } = buildSvc({
      findManyByEans: jest.fn().mockResolvedValue([product]),
    });
    const result = await svc.lookupBatch(['4006381333931', '4006381333932', 'abc'], 't-1');
    expect(result.get('4006381333931')?.found).toBe(true);
    expect(result.get('4006381333932')?.found).toBe(false);
    expect(result.get('abc')?.found).toBe(false);
  });
});
