import { Injectable } from '@nestjs/common';

import { OBF_API_VERSION, OBF_CACHE_TTL_SECONDS } from './obf.constants';
import { ObfCacheRepository } from './obf-cache.repository';
import type { ObfProduct } from './obf.types';

export interface CachedObfEntry {
  ean: string;
  product: ObfProduct | null;
  fetchedAt: Date;
  expiresAt: Date;
  hitCount: number;
  /** True when OBF returned a real product; false for negative cache. */
  fetchSuccess: boolean;
}

/**
 * Thin wrapper around `ObfCacheRepository` that knows about TTLs and
 * negative caching. Mirrors `OffCacheService` exactly.
 */
@Injectable()
export class ObfCacheService {
  constructor(private readonly repo: ObfCacheRepository) {}

  async get(ean: string): Promise<CachedObfEntry | null> {
    const row = await this.repo.findByEan(ean);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    await this.repo.incrementHit(ean);
    return {
      ean: row.ean,
      product: row.fetchSuccess ? ((row.rawData ?? null) as ObfProduct | null) : null,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      hitCount: row.hitCount + 1,
      fetchSuccess: row.fetchSuccess,
    };
  }

  async setHit(
    ean: string,
    product: ObfProduct,
    ttlSeconds = OBF_CACHE_TTL_SECONDS,
  ): Promise<void> {
    await this.repo.upsert({
      ean,
      rawData: product as unknown as Record<string, unknown>,
      productName: product.product_name_en ?? product.product_name,
      brand: product.brands?.split(',')[0]?.trim(),
      apiVersion: OBF_API_VERSION,
      fetchSuccess: true,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  async setMiss(ean: string, ttlSeconds = OBF_CACHE_TTL_SECONDS): Promise<void> {
    await this.repo.upsert({
      ean,
      rawData: null as unknown as Record<string, unknown>,
      productName: null,
      brand: null,
      apiVersion: OBF_API_VERSION,
      fetchSuccess: false,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  invalidate(ean: string): Promise<void> {
    return this.repo.invalidate(ean);
  }
}
