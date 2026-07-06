import { createHmac, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import type { AffiliateClickRow, AffiliateRevenueRow } from '@/db/schema/affiliate';

import type {
  AffiliateRevenueWebhookDto,
  LogAffiliateClickDto,
} from '../dto/affiliate-click.dto';
import { AffiliateClickRepository } from '../repositories/affiliate-click.repository';
import { AffiliatePartnerRepository } from '../repositories/affiliate-partner.repository';
import { AffiliateRevenueRepository } from '../repositories/affiliate-revenue.repository';

/**
 * BE-41 — Affiliate click + revenue tracking service.
 *
 * Two responsibilities:
 *   1. Log outbound clicks (no PII) when a user taps an alternative
 *      product link in the mobile app.
 *   2. Ingest partner-reported revenue via HMAC-signed webhook and
 *      expose aggregate sums for the Owner Dashboard.
 */
@Injectable()
export class AffiliateTrackingService {
  private readonly logger = new Logger(AffiliateTrackingService.name);

  constructor(
    private readonly clicks: AffiliateClickRepository,
    private readonly revenue: AffiliateRevenueRepository,
    private readonly partners: AffiliatePartnerRepository,
  ) {}

  /**
   * Persist an outbound click. Validates the partner exists; rejects
   * clicks against an unknown partner_id. The user_id is stored as a
   * reference only — no IP, user agent, or click context is captured.
   */
  async logClick(userId: string | null, dto: LogAffiliateClickDto): Promise<AffiliateClickRow> {
    const partner = await this.partners.findById(dto.partnerId);
    if (!partner) {
      throw new BadRequestException({
        code: 'AFFILIATE_PARTNER_UNKNOWN',
        message: `Unknown affiliate partner: ${dto.partnerId}`,
      });
    }

    const row = await this.clicks.create({
      userId,
      sourceProductEan: dto.sourceProductEan,
      alternativeProductEan: dto.alternativeProductEan,
      partnerId: partner.id,
      clickedAt: new Date(),
    });
    this.logger.debug(`Logged affiliate click ${row.id} for partner ${partner.name}`);
    return row;
  }

  /**
   * Ingest a revenue webhook. Caller MUST verify the HMAC signature
   * via `verifyWebhookSignature` before invoking this method (the
   * controller does so before deserialising the payload).
   */
  async recordRevenue(dto: AffiliateRevenueWebhookDto): Promise<AffiliateRevenueRow> {
    const partner = await this.partners.findById(dto.partnerId);
    if (!partner) {
      throw new BadRequestException({
        code: 'AFFILIATE_PARTNER_UNKNOWN',
        message: `Unknown affiliate partner: ${dto.partnerId}`,
      });
    }

    if (dto.attributedClickId) {
      const click = await this.clicks.findById(dto.attributedClickId);
      if (!click || click.partnerId !== partner.id) {
        throw new BadRequestException({
          code: 'AFFILIATE_CLICK_UNKNOWN',
          message: 'Attributed click not found for partner',
        });
      }
    }

    const row = await this.revenue.create({
      partnerId: partner.id,
      amountPaise: dto.amountPaise,
      attributedClickId: dto.attributedClickId ?? null,
      reportedAt: dto.reportedAt ? new Date(dto.reportedAt) : new Date(),
    });
    this.logger.log(
      `Revenue ${row.amountPaise}p recorded for partner ${partner.name} (row ${row.id})`,
    );
    return row;
  }

  /**
   * Total revenue (paise) per partner, in the optional time window.
   * Used by the Owner Dashboard summary widget.
   */
  async aggregateRevenueByPartner(
    since?: Date,
    until?: Date,
  ): Promise<{ partnerId: string; totalPaise: number }[]> {
    return this.revenue.aggregateByPartner(since, until);
  }

  async revenueTotalForPartner(partnerId: string, since?: Date, until?: Date): Promise<number> {
    return this.revenue.sumByPartner(partnerId, since, until);
  }

  /**
   * Verify an HMAC-SHA256 signature over the raw request body using
   * the shared partner secret. Comparison is constant-time to prevent
   * timing-attack leakage. Throws `UnauthorizedException` on mismatch.
   *
   * Signatures are accepted as either raw hex (preferred) or with the
   * `sha256=` prefix (matches GitHub-style headers).
   */
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): void {
    if (!signature) {
      throw new UnauthorizedException({
        code: 'AFFILIATE_SIGNATURE_MISSING',
        message: 'Missing webhook signature header',
      });
    }
    const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({
        code: 'AFFILIATE_SIGNATURE_INVALID',
        message: 'Invalid webhook signature',
      });
    }
  }
}
