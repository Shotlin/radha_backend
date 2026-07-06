import { Injectable } from '@nestjs/common';

import { OFF_API_VERSION, OFF_CACHE_TTL_SECONDS } from './off.constants';
import { OffCacheRepository } from './off-cache.repository';
import type { OffProduct } from './off.types';

export interface CachedOffEntry {
  ean: string;
  product: OffProduct | null;
  fetchedAt: Date;
  expiresAt: Date;
  hitCount: number;
  /** True when OFF returned a real product; false for negative cache. */
  fetchSuccess: boolean;
}

/**
 * Thin wrapper around `OffCacheRepository` that knows about TTLs and
 * negative caching. Negative entries (`fetchSuccess = false`) ensure
 * that an EAN OFF doesn't have isn't re-fetched on every Mobile_App
 * scan of the same unknown barcode.
 */
@Injectable()
export class OffCacheService {
  constructor(private readonly repo: OffCacheRepository) {}

  async get(ean: string): Promise<CachedOffEntry | null> {
    const row = await this.repo.findByEan(ean);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    await this.repo.incrementHit(ean);
    return {
      ean: row.ean,
      product: row.fetchSuccess ? ((row.rawData ?? null) as OffProduct | null) : null,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      hitCount: row.hitCount + 1,
      fetchSuccess: row.fetchSuccess,
    };
  }

  async setHit(
    ean: string,
    product: OffProduct,
    ttlSeconds = OFF_CACHE_TTL_SECONDS,
  ): Promise<void> {
    await this.repo.upsert({
      ean,
      rawData: product as unknown as Record<string, unknown>,
      productName: product.product_name_en ?? product.product_name,
      brand: product.brands?.split(',')[0]?.trim(),
      apiVersion: OFF_API_VERSION,
      fetchSuccess: true,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  async setMiss(ean: string, ttlSeconds = OFF_CACHE_TTL_SECONDS): Promise<void> {
    await this.repo.upsert({
      ean,
      rawData: null as unknown as Record<string, unknown>,
      productName: null,
      brand: null,
      apiVersion: OFF_API_VERSION,
      fetchSuccess: false,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  invalidate(ean: string): Promise<void> {
    return this.repo.invalidate(ean);
  }
}
