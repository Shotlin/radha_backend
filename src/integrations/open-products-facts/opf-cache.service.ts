import { Injectable } from '@nestjs/common';

import { OPF_API_VERSION, OPF_CACHE_TTL_SECONDS } from './opf.constants';
import { OpfCacheRepository } from './opf-cache.repository';
import type { OpfProduct } from './opf.types';

export interface CachedOpfEntry {
  ean: string;
  product: OpfProduct | null;
  fetchedAt: Date;
  expiresAt: Date;
  hitCount: number;
  fetchSuccess: boolean;
}

/**
 * Thin wrapper around `OpfCacheRepository` that knows about TTLs and
 * negative caching. Mirrors `OffCacheService` / `ObfCacheService`.
 */
@Injectable()
export class OpfCacheService {
  constructor(private readonly repo: OpfCacheRepository) {}

  async get(ean: string): Promise<CachedOpfEntry | null> {
    const row = await this.repo.findByEan(ean);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    await this.repo.incrementHit(ean);
    return {
      ean: row.ean,
      product: row.fetchSuccess ? ((row.rawData ?? null) as OpfProduct | null) : null,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      hitCount: row.hitCount + 1,
      fetchSuccess: row.fetchSuccess,
    };
  }

  async setHit(
    ean: string,
    product: OpfProduct,
    ttlSeconds = OPF_CACHE_TTL_SECONDS,
  ): Promise<void> {
    await this.repo.upsert({
      ean,
      rawData: product as unknown as Record<string, unknown>,
      productName: product.product_name_en ?? product.product_name,
      brand: product.brands?.split(',')[0]?.trim(),
      apiVersion: OPF_API_VERSION,
      fetchSuccess: true,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  async setMiss(ean: string, ttlSeconds = OPF_CACHE_TTL_SECONDS): Promise<void> {
    await this.repo.upsert({
      ean,
      rawData: null as unknown as Record<string, unknown>,
      productName: null,
      brand: null,
      apiVersion: OPF_API_VERSION,
      fetchSuccess: false,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  invalidate(ean: string): Promise<void> {
    return this.repo.invalidate(ean);
  }
}
