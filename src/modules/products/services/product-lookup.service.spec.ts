import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { products as productsTable, productNutrition, ProductRow } from '@/db/schema/products';
import { OffMapperService } from '@/integrations/open-food-facts/off-mapper.service';
import { OpenFoodFactsService } from '@/integrations/open-food-facts/off.service';
import type { IProductDataProvider } from '@/integrations/products/product-provider.types';

import { ProductNutritionRepository } from '../repositories/product-nutrition.repository';
import { ProductsRepository } from '../products.repository';

import { ProductLookupService } from './product-lookup.service';
import { ProductProviderRegistryService } from './product-provider-registry.service';

/**
 * First-ever test file for the lookup orchestrator (it had zero
 * coverage before this change — see the multi-provider plan). Locks
 * in today's OFF-only behavior FIRST, then verifies the new
 * registry-walk branch is purely additive on top of it.
 */
describe('ProductLookupService', () => {
  let service: ProductLookupService;
  let productsRepo: jest.Mocked<ProductsRepository>;
  let nutritionRepo: jest.Mocked<ProductNutritionRepository>;
  let logger: LoggerService;
  let db: jest.Mocked<DbService>;
  let off: jest.Mocked<OpenFoodFactsService>;
  let mapper: OffMapperService;
  let registry: jest.Mocked<ProductProviderRegistryService>;

  const EAN = '8906112662414'; // real, valid EAN-13 (passes the mod-10 check digit)

  function makeFakeTx(productsRow: ProductRow | undefined) {
    const productsChain = {
      values: jest.fn().mockReturnThis(),
      onConflictDoNothing: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue(productsRow ? [productsRow] : []),
    };
    const nutritionChain = {
      values: jest.fn().mockReturnThis(),
      onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    };
    const insert = jest.fn((table: unknown) =>
      table === productsTable ? productsChain : nutritionChain,
    );
    return { tx: { insert }, productsChain, nutritionChain };
  }

  function makeProductRow(overrides: Partial<ProductRow> = {}): ProductRow {
    return {
      id: 'prod-1',
      ean: EAN,
      name: 'Test Product',
      brand: 'Test Brand',
      manufacturer: null,
      categoryId: null,
      subCategory: null,
      productType: null,
      imageUrl: null,
      description: null,
      packageSize: null,
      packageUnit: null,
      packageType: null,
      status: 'active',
      isVerified: false,
      dataSource: 'manual',
      externalId: null,
      metadata: {},
      searchTsv: null,
      publicSlug: null,
      publicStatus: 'active',
      tenantId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      deletedBy: null,
      ...overrides,
    } as ProductRow;
  }

  beforeEach(() => {
    productsRepo = {
      findVisibleByEan: jest.fn().mockResolvedValue(null),
      findManyByEans: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ProductsRepository>;
    nutritionRepo = {
      findByProductId: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<ProductNutritionRepository>;
    logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;
    db = { transaction: jest.fn() } as unknown as jest.Mocked<DbService>;
    off = { lookupByEan: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<OpenFoodFactsService>;
    mapper = new OffMapperService();
    registry = { tryAll: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<ProductProviderRegistryService>;

    service = new ProductLookupService(productsRepo, nutritionRepo, logger, db, off, mapper, registry);
  });

  describe('existing OFF-only behavior (locked in before adding new providers)', () => {
    it('returns a DB hit directly without calling OFF or the registry', async () => {
      productsRepo.findVisibleByEan.mockResolvedValueOnce(makeProductRow());

      const result = await service.lookupByEan(EAN, null);

      expect(result.found).toBe(true);
      expect(result.source).toBe('database');
      expect(result.externalApiCalled).toBe(false);
      expect(off.lookupByEan).not.toHaveBeenCalled();
      expect(registry.tryAll).not.toHaveBeenCalled();
    });

    it('labels a DB hit sourced from open_food_facts as open-food-facts, not generic database', async () => {
      productsRepo.findVisibleByEan.mockResolvedValueOnce(
        makeProductRow({ dataSource: 'open_food_facts' }),
      );

      const result = await service.lookupByEan(EAN, null);

      expect(result.source).toBe('open-food-facts');
    });

    it('falls back to OFF on a DB miss, persists the hit, and never touches the registry', async () => {
      const insertedRow = makeProductRow({ dataSource: 'open_food_facts' });
      const { tx } = makeFakeTx(insertedRow);
      db.transaction.mockImplementation(async (cb) => cb(tx as never));
      off.lookupByEan.mockResolvedValueOnce({
        code: EAN,
        product_name: 'Off Product',
        brands: 'Off Brand',
      });

      const result = await service.lookupByEan(EAN, null);

      expect(result.found).toBe(true);
      expect(result.source).toBe('open-food-facts');
      expect(result.externalApiCalled).toBe(true);
      expect(registry.tryAll).not.toHaveBeenCalled(); // OFF already satisfied the lookup
    });

    it('respects fallbackToExternal: false and never calls OFF or the registry', async () => {
      const result = await service.lookupByEan(EAN, null, { fallbackToExternal: false });

      expect(result.found).toBe(false);
      expect(off.lookupByEan).not.toHaveBeenCalled();
      expect(registry.tryAll).not.toHaveBeenCalled();
    });
  });

  describe('new multi-provider registry branch (additive)', () => {
    it('tries the registry only after OFF misses, and persists the hit with the correct source', async () => {
      const insertedRow = makeProductRow({ dataSource: 'open_beauty_facts' });
      const { tx } = makeFakeTx(insertedRow);
      db.transaction.mockImplementation(async (cb) => cb(tx as never));

      const obfProvider = { providerName: 'open_beauty_facts' } as IProductDataProvider;
      registry.tryAll.mockResolvedValueOnce({
        provider: obfProvider,
        hit: {
          mapped: {
            ean: EAN,
            name: 'Soap',
            dataSource: 'open_beauty_facts',
            externalId: EAN,
          },
          nutrition: null,
        },
      });

      const result = await service.lookupByEan(EAN, null);

      expect(off.lookupByEan).toHaveBeenCalled(); // OFF tried first
      expect(registry.tryAll).toHaveBeenCalledWith(EAN); // registry tried second
      expect(result.found).toBe(true);
      expect(result.source).toBe('open-beauty-facts');
      expect(result.externalApiCalled).toBe(true);
    });

    it('returns found:false when OFF and every registry provider miss', async () => {
      const result = await service.lookupByEan(EAN, null);

      expect(result.found).toBe(false);
      expect(result.source).toBe('unknown');
      expect(off.lookupByEan).toHaveBeenCalled();
      expect(registry.tryAll).toHaveBeenCalledWith(EAN);
    });

    it('works fine with no registry injected at all (registry is @Optional())', async () => {
      const noRegistryService = new ProductLookupService(
        productsRepo,
        nutritionRepo,
        logger,
        db,
        off,
        mapper,
        undefined,
      );

      const result = await noRegistryService.lookupByEan(EAN, null);

      expect(result.found).toBe(false);
    });
  });
});
