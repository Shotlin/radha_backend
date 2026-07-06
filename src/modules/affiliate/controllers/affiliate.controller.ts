import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
  Version,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Public } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import {
  LogAffiliateClickSchema,
  type LogAffiliateClickDto,
} from '../dto/affiliate-click.dto';
import {
  AffiliateRevenueWebhookSchema,
  type AffiliateRevenueWebhookDto,
} from '../dto/affiliate-revenue.dto';
import { AffiliatePartnerRepository } from '../repositories/affiliate-partner.repository';
import { AffiliateTrackingService } from '../services/affiliate-tracking.service';

/**
 * BE-41 — Affiliate engine REST surface.
 *
 *   POST /api/v1/affiliate/clicks   Bearer      track outbound click
 *   POST /api/v1/affiliate/revenue  HMAC-only   partner revenue webhook
 *
 * Transport only — all business logic lives in
 * `AffiliateTrackingService`.
 *
 * The two routes differ in their auth model:
 *   - `clicks` is called by the mobile app over a logged-in session;
 *     `JwtAuthGuard` is applied at the class level.
 *   - `revenue` is a server-to-server webhook signed by the partner
 *     with HMAC-SHA256. It is marked `@Public()` so the JWT guard
 *     skips it, then the controller verifies the signature against
 *     the **raw** request body before parsing.
 */
@Controller('affiliate')
@UseGuards(JwtAuthGuard)
export class AffiliateController {
  constructor(
    private readonly tracking: AffiliateTrackingService,
    private readonly partners: AffiliatePartnerRepository,
  ) {}

  @Post('clicks')
  @Version('1')
  @HttpCode(201)
  async recordClick(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(LogAffiliateClickSchema)) dto: LogAffiliateClickDto,
  ): Promise<{ id: string; clickedAt: string }> {
    const row = await this.tracking.logClick(userId ?? null, dto);
    return { id: row.id, clickedAt: row.clickedAt.toISOString() };
  }

  /**
   * Partner-signed revenue webhook.
   *
   * Auth model:
   *   - HMAC-SHA256 signature in the `X-Affiliate-Signature` header
   *     over the **raw** request body.
   *   - Each partner row carries its own `hmac_secret`. A null secret
   *     means "no webhook configured" — those calls are rejected
   *     before any HMAC math runs.
   *
   * Order of operations:
   *   1. Read raw body (Nest buffers it because `rawBody: true` is
   *      set in `main.api.ts`).
   *   2. Parse JSON to extract `partnerId` so we can look up the
   *      partner's secret.
   *   3. Verify HMAC over the raw body. Mismatch ⇒ 401.
   *   4. Validate the parsed body against the Zod schema.
   *   5. Hand off to `AffiliateTrackingService.recordRevenue`.
   */
  @Post('revenue')
  @Version('1')
  @Public()
  @HttpCode(202)
  async recordRevenue(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-affiliate-signature') signature: string | undefined,
  ): Promise<{ id: string; reportedAt: string }> {
    const rawBody = this.readRawBody(req);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException({
        code: 'AFFILIATE_BODY_INVALID',
        message: 'Webhook body is not valid JSON',
      });
    }

    const partnerId = this.extractPartnerId(parsed);
    const partner = await this.partners.findById(partnerId);
    if (!partner) {
      throw new BadRequestException({
        code: 'AFFILIATE_PARTNER_UNKNOWN',
        message: `Unknown affiliate partner: ${partnerId}`,
      });
    }
    if (!partner.hmacSecret) {
      throw new BadRequestException({
        code: 'AFFILIATE_PARTNER_WEBHOOK_DISABLED',
        message: 'Partner has no webhook secret configured',
      });
    }

    this.tracking.verifyWebhookSignature(rawBody, signature ?? '', partner.hmacSecret);

    const dto: AffiliateRevenueWebhookDto = AffiliateRevenueWebhookSchema.parse(parsed);
    const row = await this.tracking.recordRevenue(dto);
    return { id: row.id, reportedAt: row.reportedAt.toISOString() };
  }

  private readRawBody(req: RawBodyRequest<Request>): string {
    if (req.rawBody && req.rawBody.length > 0) {
      return req.rawBody.toString('utf8');
    }
    throw new BadRequestException({
      code: 'AFFILIATE_BODY_MISSING',
      message: 'Empty webhook body',
    });
  }

  private extractPartnerId(parsed: unknown): string {
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'partnerId' in parsed &&
      typeof (parsed as { partnerId: unknown }).partnerId === 'string'
    ) {
      return (parsed as { partnerId: string }).partnerId;
    }
    throw new BadRequestException({
      code: 'AFFILIATE_PARTNER_ID_MISSING',
      message: 'Webhook body must include partnerId',
    });
  }
}
