import { Injectable, Logger } from '@nestjs/common';

import type { AffiliatePartnerRow } from '@/db/schema/affiliate';

import { AffiliatePartnerRepository } from '../repositories/affiliate-partner.repository';

/**
 * BE-41 — Affiliate link builder.
 *
 * Renders a partner-specific click-out URL by substituting the
 * `{ean}` and `{affiliateId}` placeholders inside `link_template`.
 * Inactive partners are filtered out — callers fall back to the next
 * available partner.
 *
 * Examples of `link_template` shapes a partner row may carry:
 *   `https://www.amazon.in/dp/{ean}?tag={affiliateId}`
 *   `https://www.flipkart.com/p?pid={ean}&affid={affiliateId}`
 */
@Injectable()
export class AffiliateLinkService {
  private readonly logger = new Logger(AffiliateLinkService.name);

  constructor(private readonly partners: AffiliatePartnerRepository) {}

  /**
   * Build a click-out URL for a given EAN. When `partnerName` is
   * provided we look that partner up by name; otherwise we cycle
   * through the active list and pick the first match. Returns null
   * when no active partner is available.
   */
  async buildLink(
    ean: string,
    partnerName?: string,
  ): Promise<{ url: string; partner: AffiliatePartnerRow } | null> {
    const partner = partnerName
      ? await this.partners.findActiveByName(partnerName)
      : (await this.partners.findActive())[0] ?? null;

    if (!partner) {
      this.logger.warn(
        partnerName
          ? `No active affiliate partner named "${partnerName}"`
          : 'No active affiliate partners configured',
      );
      return null;
    }

    return { url: this.render(partner, ean), partner };
  }

  /**
   * Build a click-out URL with an explicit partner row already in
   * hand. Used by `HealthyAlternativesService` to avoid a second
   * round-trip per recommendation.
   */
  buildLinkWithPartner(ean: string, partner: AffiliatePartnerRow): string {
    return this.render(partner, ean);
  }

  /**
   * Pure template rendering. Replaces every `{ean}` and `{affiliateId}`
   * placeholder. Both placeholders are URL-encoded so unusual values
   * remain safe in the resulting URL.
   */
  private render(partner: AffiliatePartnerRow, ean: string): string {
    return partner.linkTemplate
      .replace(/\{ean\}/g, encodeURIComponent(ean))
      .replace(/\{affiliateId\}/g, encodeURIComponent(partner.affiliateId));
  }
}
