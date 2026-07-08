import { BadRequestException } from '@nestjs/common';

import type { ImageFallbackCacheRow, NewImageFallbackCache } from '@/db/schema/image-fallback-cache';
import { LoggerService } from '@/logging/logger.service';
import {
  ERROR_TRACKING_SERVICE,
  IErrorTrackingService,
} from '@/observability/error-tracking.types';

import type { IOffLookupPort, OffLookupResult } from '../ports/off-lookup.port';
import type {
  IProductsLookupPort,
  ProductsLookupResult,
} from '../ports/products-lookup.port';
import { ImageCacheService } from '../services/image-cache.service';
import { ImageFallbackService } from '../services/image-fallback.service';
import { VisionOcrResult, VisionOcrService } from '../services/vision-ocr.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    log: jest.fn(),
    logError: jest.fn(),
  }) as unknown as LoggerService;

const buildErrorTracking = (): jest.Mocked<IErrorTrackingService> => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  clearUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  setContext: jest.fn(),
});

/**
 * In-memory `ImageCacheService` stand-in that exercises the same
 * public surface the orchestrator depends on. Hashing follows the
 * same `sha256(s3ObjectKey)` rule so test inputs produce stable
 * cache keys.
 */
class InMemoryImageCache {
  readonly rows = new Map<string, ImageFallbackCacheRow>();
  hashFn: (key: string) => string = (key) => `hash:${key}`;
  findByHash = jest.fn(async (h: string) => this.rows.get(h) ?? null);
  upsert = jest.fn(async (data: NewImageFallbackCache) => {
    const existing = this.rows.get(data.imageSha256);
    if (existing) return existing;
    const now = new Date();
    const row: ImageFallbackCacheRow = {
      id: `cache-${this.rows.size + 1}`,
      createdAt: now,
      updatedAt: now,
      imageSha256: data.imageSha256,
      s3ObjectKey: data.s3ObjectKey,
      ean: data.ean ?? null,
      productName: data.productName ?? null,
      brand: data.brand ?? null,
      source: data.source ?? 'none',
      matched: data.matched ?? false,
      matchedAt: data.matchedAt ?? null,
      visionCostPaise: data.visionCostPaise ?? 0,
      generatedBy: data.generatedBy ?? null,
      fetchedAt: data.fetchedAt ?? now,
    };
    this.rows.set(data.imageSha256, row);
    return row;
  });
  hash(key: string): string {
    return this.hashFn(key);
  }
  /** Helper to seed a row directly (cache-hit tests). */
  seed(row: ImageFallbackCacheRow): void {
    this.rows.set(row.imageSha256, row);
  }
}

const buildVision = (
  overrides: Partial<VisionOcrResult> = {},
): jest.Mocked<VisionOcrService> => {
  const result: VisionOcrResult = {
    name: 'Mock Cereal',
    brand: 'Mock Brand',
    confidence: 0.95,
    costPaise: 1,
    provider: 'mock',
    ...overrides,
  };
  return {
    recognize: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<VisionOcrService>;
};

const buildProductsPort = (
  result: ProductsLookupResult | null = null,
): jest.Mocked<IProductsLookupPort> =>
  ({
    findByNameBrand: jest.fn().mockResolvedValue(result),
  }) as unknown as jest.Mocked<IProductsLookupPort>;

const buildOffPort = (
  result: OffLookupResult | null = null,
): jest.Mocked<IOffLookupPort> =>
  ({
    findByNameBrand: jest.fn().mockResolvedValue(result),
  }) as unknown as jest.Mocked<IOffLookupPort>;

const buildService = (overrides: {
  cache?: InMemoryImageCache;
  vision?: jest.Mocked<VisionOcrService>;
  products?: jest.Mocked<IProductsLookupPort>;
  off?: jest.Mocked<IOffLookupPort>;
  errorTracking?: jest.Mocked<IErrorTrackingService>;
} = {}) => {
  const cache = overrides.cache ?? new InMemoryImageCache();
  const vision = overrides.vision ?? buildVision();
  const products = overrides.products ?? buildProductsPort();
  const off = overrides.off ?? buildOffPort();
  const errorTracking = overrides.errorTracking ?? buildErrorTracking();
  const service = new ImageFallbackService(
    cache as unknown as ImageCacheService,
    vision,
    products,
    off,
    buildLogger(),
    errorTracking,
  );
  return { service, cache, vision, products, off, errorTracking };
};

describe('ImageFallbackService', () => {
  describe('input validation', () => {
    it('rejects empty s3ObjectKey', async () => {
      const { service } = buildService();
      await expect(service.identify({ s3ObjectKey: '   ' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('cache hit', () => {
    it('returns the cached match without calling Vision', async () => {
      const cache = new InMemoryImageCache();
      cache.seed({
        id: 'r1',
        createdAt: new Date(),
        updatedAt: new Date(),
        imageSha256: 'hash:uploads/photo.jpg',
        s3ObjectKey: 'uploads/photo.jpg',
        ean: '8901030865278',
        productName: 'Maggi Noodles',
        brand: 'Maggi',
        source: 'catalog',
        matched: true,
        matchedAt: new Date(),
        visionCostPaise: 0,
        generatedBy: 'mock',
        fetchedAt: new Date(),
      });
      const { service, vision } = buildService({ cache });

      const result = await service.identify({ s3ObjectKey: 'uploads/photo.jpg' });

      expect(result).toEqual({
        matched: true,
        ean: '8901030865278',
        productName: 'Maggi Noodles',
        brand: 'Maggi',
        source: 'catalog',
        costPaise: 0,
      });
      expect(vision.recognize).not.toHaveBeenCalled();
      // No new row inserted on hit.
      expect(cache.upsert).not.toHaveBeenCalled();
    });

    it('returns a cached miss without re-running Vision', async () => {
      const cache = new InMemoryImageCache();
      cache.seed({
        id: 'r2',
        createdAt: new Date(),
        updatedAt: new Date(),
        imageSha256: 'hash:uploads/junk.jpg',
        s3ObjectKey: 'uploads/junk.jpg',
        ean: null,
        productName: null,
        brand: null,
        source: 'none',
        matched: false,
        matchedAt: null,
        visionCostPaise: 1,
        generatedBy: 'mock',
        fetchedAt: new Date(),
      });
      const { service, vision } = buildService({ cache });

      const result = await service.identify({ s3ObjectKey: 'uploads/junk.jpg' });

      expect(result).toEqual({
        matched: false,
        source: 'none',
        costPaise: 1,
      });
      expect(vision.recognize).not.toHaveBeenCalled();
    });
  });

  describe('catalog match', () => {
    it('returns source=catalog and persists the match', async () => {
      const cache = new InMemoryImageCache();
      const products = buildProductsPort({
        ean: '8901030865278',
        name: 'Maggi 2-Min Noodles',
        brand: 'Maggi',
      });
      const off = buildOffPort();
      const { service } = buildService({ cache, products, off });

      const result = await service.identify({ s3ObjectKey: 'uploads/cereal.jpg' });

      expect(result).toEqual({
        matched: true,
        ean: '8901030865278',
        productName: 'Maggi 2-Min Noodles',
        brand: 'Maggi',
        source: 'catalog',
        costPaise: 1,
      });
      expect(off.findByNameBrand).not.toHaveBeenCalled();
      expect(cache.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          imageSha256: 'hash:uploads/cereal.jpg',
          ean: '8901030865278',
          source: 'catalog',
          matched: true,
          visionCostPaise: 1,
          generatedBy: 'mock',
        }),
      );
    });
  });

  describe('OFF fallback', () => {
    it('returns source=off when catalog has no match but OFF does', async () => {
      const cache = new InMemoryImageCache();
      const products = buildProductsPort(null);
      const off = buildOffPort({
        ean: '8901058050677',
        name: 'Mock Cereal',
        brand: 'Mock Brand',
      });
      const { service } = buildService({ cache, products, off });

      const result = await service.identify({ s3ObjectKey: 'uploads/cereal.jpg' });

      expect(result).toEqual({
        matched: true,
        ean: '8901058050677',
        productName: 'Mock Cereal',
        brand: 'Mock Brand',
        source: 'off',
        costPaise: 1,
      });
      expect(products.findByNameBrand).toHaveBeenCalledWith({
        name: 'Mock Cereal',
        brand: 'Mock Brand',
      });
      expect(off.findByNameBrand).toHaveBeenCalledWith({
        name: 'Mock Cereal',
        brand: 'Mock Brand',
      });
    });
  });

  describe('no match', () => {
    it('returns matched=false, source=none when neither port matches', async () => {
      const cache = new InMemoryImageCache();
      const { service } = buildService({ cache });

      const result = await service.identify({ s3ObjectKey: 'uploads/empty.jpg' });

      expect(result).toEqual({
        matched: false,
        source: 'none',
        costPaise: 1,
      });
      expect(cache.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          imageSha256: 'hash:uploads/empty.jpg',
          source: 'none',
          matched: false,
          visionCostPaise: 1,
        }),
      );
    });
  });

  describe('graceful failure', () => {
    it('returns matched=false and captures the exception when Vision throws', async () => {
      const cache = new InMemoryImageCache();
      const vision = {
        recognize: jest.fn().mockRejectedValue(new Error('Vision unreachable')),
      } as unknown as jest.Mocked<VisionOcrService>;
      const errorTracking = buildErrorTracking();
      const { service } = buildService({ cache, vision, errorTracking });

      const result = await service.identify({ s3ObjectKey: 'uploads/x.jpg' });

      expect(result).toEqual({ matched: false, source: 'none', costPaise: 0 });
      expect(errorTracking.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          module: 'image-fallback',
          metadata: expect.objectContaining({ phase: 'vision-ocr' }),
        }),
      );
      // We still persist a negative-cache row so retries short-circuit.
      expect(cache.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'none',
          matched: false,
          visionCostPaise: 0,
        }),
      );
    });

    it('falls through to OFF when the catalog port itself throws', async () => {
      const cache = new InMemoryImageCache();
      const products = {
        findByNameBrand: jest.fn().mockRejectedValue(new Error('catalog DB down')),
      } as unknown as jest.Mocked<IProductsLookupPort>;
      const off = buildOffPort({
        ean: '8901058050677',
        name: 'Mock Cereal',
        brand: 'Mock Brand',
      });
      const { service } = buildService({ cache, products, off });

      const result = await service.identify({ s3ObjectKey: 'uploads/x.jpg' });

      expect(result.source).toBe('off');
      expect(result.matched).toBe(true);
    });
  });

  describe('concurrent dedupe', () => {
    it('two simultaneous calls with the same key collapse to a single Vision invocation on the second pass', async () => {
      const cache = new InMemoryImageCache();
      const vision = buildVision();
      const products = buildProductsPort({
        ean: '8901030865278',
        name: 'Maggi',
        brand: 'Maggi',
      });
      const { service } = buildService({ cache, vision, products });

      // First call — burns Vision and seeds the cache.
      await service.identify({ s3ObjectKey: 'uploads/dup.jpg' });
      // Second call — must hit the cache row planted by the first.
      await service.identify({ s3ObjectKey: 'uploads/dup.jpg' });

      expect(vision.recognize).toHaveBeenCalledTimes(1);
    });
  });

  describe('locale handling', () => {
    it('normalises supported locales before passing them to Vision', async () => {
      const vision = buildVision();
      const { service } = buildService({ vision });

      await service.identify({ s3ObjectKey: 'uploads/x.jpg', locale: 'HI' });

      expect(vision.recognize).toHaveBeenCalledWith(
        'uploads/x.jpg',
        expect.stringMatching(/^(hi|en)$/),
      );
    });

    it('falls back to en when locale is unsupported', async () => {
      const vision = buildVision();
      const { service } = buildService({ vision });

      await service.identify({ s3ObjectKey: 'uploads/x.jpg', locale: 'fr' });

      expect(vision.recognize).toHaveBeenCalledWith('uploads/x.jpg', 'en');
    });
  });

  describe('response shape contract', () => {
    it('always returns matched, source and costPaise', async () => {
      const { service } = buildService();
      const result = await service.identify({ s3ObjectKey: 'uploads/x.jpg' });
      expect(result).toEqual(
        expect.objectContaining({
          matched: expect.any(Boolean),
          source: expect.stringMatching(/^(catalog|off|none)$/),
          costPaise: expect.any(Number),
        }),
      );
    });

    it('omits product fields on miss', async () => {
      const { service } = buildService();
      const result = await service.identify({ s3ObjectKey: 'uploads/x.jpg' });
      expect(result.ean).toBeUndefined();
      expect(result.productName).toBeUndefined();
      expect(result.brand).toBeUndefined();
    });
  });
});
