import { Injectable } from '@nestjs/common';

import { getDefaultThreshold } from '../constants/default-thresholds';
import { ExpiryThresholdsRepository } from '../repositories/expiry-thresholds.repository';
import type { ResolvedThreshold } from '../types/expiry.types';

/**
 * BE-18 — Threshold resolution.
 *
 * Lookup precedence:
 *   1. Tenant-specific row (`expiry_thresholds.tenant_id = $tenantId`).
 *   2. Global DB row        (`expiry_thresholds.tenant_id IS NULL`).
 *   3. In-process platform default (`DEFAULT_EXPIRY_THRESHOLDS`).
 *
 * The third tier means the API stays usable even before the
 * defaults seeder runs in fresh dev environments.
 */
@Injectable()
export class ExpiryThresholdService {
  constructor(private readonly repo: ExpiryThresholdsRepository) {}

  async resolve(category: string | null | undefined, tenantId: string): Promise<ResolvedThreshold> {
    const cat = (category ?? 'other').toLowerCase();
    const dbRow = await this.repo.findEffective(cat, tenantId);
    if (dbRow) {
      return {
        category: dbRow.category,
        yellowDays: dbRow.yellowDays,
        redDays: dbRow.redDays,
        isPlatformDefault: false,
        tenantId: dbRow.tenantId,
      };
    }
    const fallback = getDefaultThreshold(cat);
    return {
      category: fallback.category,
      yellowDays: fallback.yellowDays,
      redDays: fallback.redDays,
      isPlatformDefault: true,
      tenantId: null,
    };
  }

  async listForTenant(tenantId: string, category?: string) {
    return this.repo.listForTenant(tenantId, category);
  }

  async upsertForTenant(
    tenantId: string,
    userId: string,
    data: { category: string; yellowDays: number; redDays: number },
  ) {
    return this.repo.upsertForTenant(tenantId, userId, {
      category: data.category.toLowerCase(),
      yellowDays: data.yellowDays,
      redDays: data.redDays,
    });
  }
}
