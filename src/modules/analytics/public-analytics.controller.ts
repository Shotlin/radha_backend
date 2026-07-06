import { Body, Controller, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { Public } from '@/modules/auth/decorators/auth.decorators';

import { CreateLeadSchema, type CreateLeadDto } from './dto/create-lead.dto';
import { TrackWebsiteEventSchema, type TrackWebsiteEventDto } from './dto/track-website-event.dto';
import { PublicRateLimitGuard } from './guards/public-rate-limit.guard';
import { LeadsService } from './services/leads.service';
import { WebsiteAnalyticsService } from './services/website-analytics.service';

/**
 * BE-29 — Public analytics surface.
 *
 *   POST /api/v1/analytics/website/events  — anonymous event ingestion
 *   POST /api/v1/marketing/leads           — anonymous lead capture
 *
 * Marked `@Public()` so the JWT guard skips them. Rate-limited per IP
 * (hashed) via `PublicRateLimitGuard`.
 *
 * CORS handling for the marketing site origin lives in the API
 * bootstrap (`main.api.ts`). The orchestrator owns that wiring — see
 * the BE-29 handoff for the exact origin list to allow.
 */
@Controller()
@UseGuards(PublicRateLimitGuard)
@Public()
export class PublicAnalyticsController {
  constructor(
    private readonly websiteAnalytics: WebsiteAnalyticsService,
    private readonly leads: LeadsService,
  ) {}

  @Post('analytics/website/events')
  @Version('1')
  @HttpCode(202)
  async trackWebsiteEvent(
    @Body(new ZodValidationPipe(TrackWebsiteEventSchema)) dto: TrackWebsiteEventDto,
  ): Promise<{ accepted: true }> {
    await this.websiteAnalytics.trackEvent(dto);
    return { accepted: true };
  }

  @Post('marketing/leads')
  @Version('1')
  @HttpCode(201)
  async createLead(
    @Body(new ZodValidationPipe(CreateLeadSchema)) dto: CreateLeadDto,
  ): Promise<{ id: string; status: string }> {
    const lead = await this.leads.createLead(dto);
    return { id: lead.id, status: lead.status };
  }
}
