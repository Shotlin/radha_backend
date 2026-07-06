import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AffiliatePartnerRow } from '@/db/schema/affiliate';

import type { HealthierAlternativeDto } from '../dto/healthier-alternative.dto';
import { AffiliatePartnerRepository } from '../repositories/affiliate-partner.repository';
import {
  PRODUCTS_LOOKUP_PORT,
  type FindHealthierOptions,
  type ProductCatalogEntry,
  type ProductsLookupPort,
} from '../types/affiliate.types';
import { AffiliateLinkService } from './affiliate-link.service';

/**
 * BE-41 — Healthy Alternatives recommendation service.
 *
 * Implements the engine described in BE-41_PHASE.md:
 *
 *   - Looks up candidate products in the same category as the source
 *     EAN whose `healthScore` is at least `MIN_HEALTH_DELTA` higher.
 *   - Returns the top `MAX_ALTERNATIVES` candidates sorted by score.
 *   - Attaches a partner-rendered affiliate link to each candidate.
 *
 * The service does NOT perform entitlement gating itself — the
 * controller is responsible for that. This keeps the engine
 * unit-testable in isolation and reusable from BE-10 v2 scan output.
 */
@Injectable()
export class HealthyAlternativesService {
  private readonly logger = new Logger(HealthyAlternativesService.name);

  /** Top N alternatives returned per recommendation call. */
  static readonly MAX_ALTERNATIVES = 3;

  /**
   * Minimum health-score delta a candidate must have over the source
   * product before we recommend it. Prevents recommending products
   * that are only marginally healthier (which would feel like an
   * arbitrary upsell to the consumer).
   */
  static readonly MIN_HEALTH_DELTA = 10;

  constructor(
    @Inject(PRODUCTS_LOOKUP_PORT) private readonly products: ProductsLookupPort,
    private readonly partners: AffiliatePartnerRepository,
    private readonly linkBuilder: AffiliateLinkService,
  ) {}

  /**
   * Recommend up to `MAX_ALTERNATIVES` healthier products for a
   * source EAN. Returns an empty array (never throws) whenever the
   * source can't be found, no candidates pass the delta gate, or no
   * active affiliate partner is configured.
   */
  async recommend(
    sourceEan: string,
    options?: { partnerName?: string; limit?: number; minDelta?: number },
  ): Promise<HealthierAlternativeDto[]> {
    const source = await this.products.findByEan(sourceEan);
    if (!source) {
      this.logger.debug(`No source product found for EAN ${sourceEan}`);
      return [];
    }

    const lookupOptions: FindHealthierOptions = {
      limit: options?.limit ?? HealthyAlternativesService.MAX_ALTERNATIVES,
      minDelta: options?.minDelta ?? HealthyAlternativesService.MIN_HEALTH_DELTA,
    };

    const candidates = await this.products.findHealthierThan(sourceEan, lookupOptions);
    if (candidates.length === 0) return [];

    const partner = await this.pickPartner(options?.partnerName);
    if (!partner) {
      this.logger.warn('No active affiliate partner — returning empty alternatives.');
      return [];
    }

    return candidates.map((c) => this.toDto(c, partner));
  }

  /**
   * Resolve the partner used for link rendering. Prefers the
   * caller-supplied partner name when active; otherwise falls back to
   * the first active partner in the catalog. Returns null if no
   * active partner exists.
   */
  private async pickPartner(preferredName?: string): Promise<AffiliatePartnerRow | null> {
    if (preferredName) {
      const named = await this.partners.findActiveByName(preferredName);
      if (named) return named;
    }
    const active = await this.partners.findActive();
    return active[0] ?? null;
  }

  private toDto(
    candidate: ProductCatalogEntry,
    partner: AffiliatePartnerRow,
  ): HealthierAlternativeDto {
    return {
      ean: candidate.ean,
      name: candidate.name,
      brand: candidate.brand,
      healthScore: candidate.healthScore,
      affiliateLink: this.linkBuilder.buildLinkWithPartner(candidate.ean, partner),
      partnerName: partner.name,
      partnerId: partner.id,
    };
  }
}
