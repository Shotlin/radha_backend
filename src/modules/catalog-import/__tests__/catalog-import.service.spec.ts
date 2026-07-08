import { LoggerService } from '@/logging/logger.service';
import { OffMapperService } from '@/integrations/open-food-facts/off-mapper.service';
import { OpenFoodFactsService } from '@/integrations/open-food-facts/off.service';
import type {
  MappedNutritionData,
  MappedProductData,
  OffProduct,
} from '@/integrations/open-food-facts/off.types';
import { HealthScoringService } from '@/modules/health-scoring/services/health-scoring.service';
import { ProductCategoriesRepository } from '@/modules/products/repositories/product-categories.repository';
import { ProductNutritionRepository } from '@/modules/products/repositories/product-nutrition.repository';
import { ProductsRepository } from '@/modules/products/products.repository';

import { CATALOG_CATEGORIES } from '../catalog-import.constants';
import { CatalogImportService } from '../catalog-import.service';
import { CURATED_CATALOG } from '../curated-catalog.constants';

const FOOD_TAG_COUNT = CATALOG_CATEGORIES.reduce((n, c) => n + c.offCategoryTags.length, 0);
const CURATED_COUNT = CURATED_CATALOG.length;

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const sampleOff = (code = '8901234567890'): OffProduct => ({ code, product_name: 'Test Cookies' });

const sampleMappedProduct = (ean = '8901234567890'): MappedProductData => ({
  ean,
  name: 'Test Cookies',
  brand: 'Acme',
  dataSource: 'open_food_facts',
  externalId: ean,
});

const sampleNutrition = (): MappedNutritionData => ({
  servingSize: 100,
  servingUnit: 'g',
  calories: 480,
  protein: 6,
  containsAllergens: ['gluten'],
  isProcessed: 'ultra',
  dataSource: 'open_food_facts',
  confidence: 0.8,
});

interface Mocks {
  off: jest.Mocked<Pick<OpenFoodFactsService, 'searchByCategory' | 'searchByText'>>;
  mapper: jest.Mocked<Pick<OffMapperService, 'mapToProduct' | 'mapToNutrition' | 'confidence'>>;
  products: jest.Mocked<Pick<ProductsRepository, 'upsertGlobalByEan'>>;
  nutrition: jest.Mocked<Pick<ProductNutritionRepository, 'upsertForProduct'>>;
  categories: jest.Mocked<Pick<ProductCategoriesRepository, 'ensureGlobal'>>;
  scoring: jest.Mocked<Pick<HealthScoringService, 'scoreProduct'>>;
}

const build = (over: Partial<Mocks> = {}): { svc: CatalogImportService } & Mocks => {
  const off = {
    // page 1 yields one product; later pages are empty so paging terminates.
    searchByCategory: jest
      .fn()
      .mockImplementation((_tag: string, opts: { page?: number }) =>
        Promise.resolve((opts.page ?? 1) === 1 ? [sampleOff()] : []),
      ),
    // Text search echoes the query into the candidate name so the resolver's
    // token-overlap match is strong for every curated seed (real-looking EAN).
    searchByText: jest
      .fn()
      .mockImplementation((terms: string) =>
        Promise.resolve([{ code: '8901234567890', product_name: terms } as OffProduct]),
      ),
    ...over.off,
  } as Mocks['off'];
  const mapper = {
    mapToProduct: jest.fn().mockReturnValue(sampleMappedProduct()),
    mapToNutrition: jest.fn().mockReturnValue(sampleNutrition()),
    confidence: jest.fn().mockReturnValue(0.8),
    ...over.mapper,
  } as Mocks['mapper'];
  const products = {
    upsertGlobalByEan: jest.fn().mockResolvedValue({ id: 'p-1', ean: '8901234567890' }),
    ...over.products,
  } as Mocks['products'];
  const nutrition = {
    upsertForProduct: jest.fn().mockResolvedValue({ id: 'n-1' }),
    ...over.nutrition,
  } as Mocks['nutrition'];
  const categories = {
    ensureGlobal: jest
      .fn()
      .mockImplementation((c: { slug: string }) =>
        Promise.resolve({ id: `c-${c.slug}`, slug: c.slug }),
      ),
    ...over.categories,
  } as Mocks['categories'];
  const scoring = {
    scoreProduct: jest.fn().mockResolvedValue({ overallScore: 50 }),
    ...over.scoring,
  } as Mocks['scoring'];

  const svc = new CatalogImportService(
    off as unknown as OpenFoodFactsService,
    mapper as unknown as OffMapperService,
    products as unknown as ProductsRepository,
    nutrition as unknown as ProductNutritionRepository,
    categories as unknown as ProductCategoriesRepository,
    scoring as unknown as HealthScoringService,
    buildLogger(),
  );
  return { svc, off, mapper, products, nutrition, categories, scoring };
};

describe('CatalogImportService.run', () => {
  it('ensures every category and only fetches OFF for food categories', async () => {
    const { svc, off, categories } = build();

    const summary = await svc.run({ pagesPerCategory: 1 });

    expect(categories.ensureGlobal).toHaveBeenCalledTimes(CATALOG_CATEGORIES.length);
    expect(summary.categoriesEnsured).toBe(CATALOG_CATEGORIES.length);
    // OFF queried once per food tag; never for empty (non-food) tags.
    expect(off.searchByCategory).toHaveBeenCalledTimes(FOOD_TAG_COUNT);
    for (const [tag] of off.searchByCategory.mock.calls) {
      expect(typeof tag).toBe('string');
      expect((tag as string).length).toBeGreaterThan(0);
    }
  });

  it('upserts, stores nutrition, and scores each imported product', async () => {
    const { svc, products, nutrition, scoring } = build();

    const summary = await svc.run({ pagesPerCategory: 1 });

    expect(products.upsertGlobalByEan).toHaveBeenCalledTimes(FOOD_TAG_COUNT);
    expect(nutrition.upsertForProduct).toHaveBeenCalledTimes(FOOD_TAG_COUNT);
    expect(scoring.scoreProduct).toHaveBeenCalledTimes(FOOD_TAG_COUNT);
    expect(summary.productsUpserted).toBe(FOOD_TAG_COUNT);
    expect(summary.nutritionUpserted).toBe(FOOD_TAG_COUNT);
    expect(summary.scored).toBe(FOOD_TAG_COUNT);
    expect(summary.errors).toBe(0);
    // Global catalog only.
    expect(products.upsertGlobalByEan.mock.calls[0][0].tenantId).toBeNull();
  });

  it('skips products with an invalid (too-long) EAN — no fabricated rows', async () => {
    const { svc, products } = build({
      mapper: {
        mapToProduct: jest.fn().mockReturnValue(sampleMappedProduct('123456789012345')),
        mapToNutrition: jest.fn().mockReturnValue(null),
      } as unknown as Mocks['mapper'],
    });

    const summary = await svc.run({ pagesPerCategory: 1 });

    expect(products.upsertGlobalByEan).not.toHaveBeenCalled();
    expect(summary.productsUpserted).toBe(0);
    expect(summary.skipped).toBe(FOOD_TAG_COUNT);
  });

  it('counts an error and continues when a product upsert throws', async () => {
    const { svc, scoring } = build({
      products: {
        upsertGlobalByEan: jest.fn().mockRejectedValue(new Error('db down')),
      } as unknown as Mocks['products'],
    });

    const summary = await svc.run({ pagesPerCategory: 1 });

    expect(summary.errors).toBe(FOOD_TAG_COUNT);
    expect(summary.productsUpserted).toBe(0);
    expect(scoring.scoreProduct).not.toHaveBeenCalled();
  });

  it('imports the product but skips nutrition when OFF has none', async () => {
    const { svc, products, nutrition } = build({
      mapper: {
        mapToProduct: jest.fn().mockReturnValue(sampleMappedProduct()),
        mapToNutrition: jest.fn().mockReturnValue(null),
      } as unknown as Mocks['mapper'],
    });

    const summary = await svc.run({ pagesPerCategory: 1 });

    expect(products.upsertGlobalByEan).toHaveBeenCalledTimes(FOOD_TAG_COUNT);
    expect(nutrition.upsertForProduct).not.toHaveBeenCalled();
    expect(summary.productsUpserted).toBe(FOOD_TAG_COUNT);
    expect(summary.nutritionUpserted).toBe(0);
  });
});

describe('CatalogImportService.importCurated', () => {
  it('resolves a real EAN per curated product and seeds it (never fabricates a barcode)', async () => {
    const { svc, off, products, scoring } = build();

    const summary = await svc.importCurated();

    // One OFF text-search per curated product; no guessed barcodes.
    expect(off.searchByText).toHaveBeenCalledTimes(CURATED_COUNT);
    expect(summary.categoriesEnsured).toBe(CATALOG_CATEGORIES.length);
    expect(summary.productsUpserted).toBe(CURATED_COUNT);
    expect(summary.scored).toBe(CURATED_COUNT);
    expect(summary.unresolved).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.items).toHaveLength(CURATED_COUNT);
    expect(summary.items.every((i) => i.status === 'seeded' && i.resolvedEan)).toBe(true);
    // Seeded into the global catalog only.
    expect(products.upsertGlobalByEan.mock.calls[0][0].tenantId).toBeNull();
    expect(scoring.scoreProduct).toHaveBeenCalledTimes(CURATED_COUNT);
  });

  it('marks a product unresolved when OFF returns no candidate — no seed, no guess', async () => {
    const { svc, products } = build({
      off: {
        searchByCategory: jest.fn().mockResolvedValue([]),
        searchByText: jest.fn().mockResolvedValue([]),
      } as unknown as Mocks['off'],
    });

    const summary = await svc.importCurated();

    expect(products.upsertGlobalByEan).not.toHaveBeenCalled();
    expect(summary.productsUpserted).toBe(0);
    expect(summary.unresolved).toBe(CURATED_COUNT);
    expect(summary.items.every((i) => i.status === 'unresolved' && i.resolvedEan === null)).toBe(
      true,
    );
  });

  it('rejects candidates below the confidence bar rather than seeding a weak match', async () => {
    const { svc, products } = build({
      off: {
        searchByCategory: jest.fn().mockResolvedValue([]),
        // Candidate name shares no tokens with any curated product → low score.
        searchByText: jest
          .fn()
          .mockResolvedValue([{ code: '8909999999999', product_name: 'zzz qqq' } as OffProduct]),
      } as unknown as Mocks['off'],
      mapper: {
        mapToProduct: jest.fn().mockReturnValue(sampleMappedProduct()),
        mapToNutrition: jest.fn().mockReturnValue(sampleNutrition()),
        confidence: jest.fn().mockReturnValue(0.1),
      } as unknown as Mocks['mapper'],
    });

    const summary = await svc.importCurated({ minConfidence: 0.45 });

    expect(products.upsertGlobalByEan).not.toHaveBeenCalled();
    expect(summary.unresolved).toBe(CURATED_COUNT);
  });

  it('skips candidates whose OFF code is not a valid retail barcode', async () => {
    const { svc, products } = build({
      off: {
        searchByCategory: jest.fn().mockResolvedValue([]),
        searchByText: jest
          .fn()
          .mockImplementation((terms: string) =>
            Promise.resolve([{ code: '123456789012345', product_name: terms } as OffProduct]),
          ),
      } as unknown as Mocks['off'],
    });

    const summary = await svc.importCurated();

    expect(products.upsertGlobalByEan).not.toHaveBeenCalled();
    expect(summary.unresolved).toBe(CURATED_COUNT);
  });
});
