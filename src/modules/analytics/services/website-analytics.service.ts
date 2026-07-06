import { Injectable } from '@nestjs/common';

import { redactPII } from '@/common/utils/redact.utils';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';

import { WebsiteEventsRepository } from '../repositories/website-events.repository';
import type {
  DateRange,
  FunnelData,
  IWebsiteAnalyticsService,
  PageStat,
  TrackWebsiteEventInput,
  TrafficSource,
  WebsiteStats,
} from '../types/analytics.types';
import { sha256WithSalt } from '../utils/analytics-hash.util';
import { toIsoDate } from '../utils/date-range.util';

/**
 * BE-29 — Public website analytics service.
 *
 * Privacy posture:
 *   - Visitor / session IDs are hashed with `ANALYTICS_HASH_SALT`
 *     before persist — see `analytics-hash.util.ts`.
 *   - `metadata` is run through `redactPII()` so any accidental PII
 *     in custom event properties is stripped at write time.
 *   - No raw IP, no city-level geo. The DB schema doesn't even have
 *     columns for them.
 */
@Injectable()
export class WebsiteAnalyticsService implements IWebsiteAnalyticsService {
  constructor(
    private readonly repo: WebsiteEventsRepository,
    private readonly config: ConfigService,
    private readonly appLogger: LoggerService,
  ) {}

  async trackEvent(input: TrackWebsiteEventInput): Promise<void> {
    const salt = this.getSalt();
    const visitorIdHash = sha256WithSalt(input.visitorId ?? input.sessionId, salt);
    const sessionIdHash = sha256WithSalt(input.sessionId, salt);

    const metadata = input.metadata ? redactPII(input.metadata) : null;
    const yearMonthDay = toIsoDate(new Date());

    await this.repo.create({
      type: input.type,
      page: input.page ?? null,
      pageTitle: input.pageTitle ?? null,
      referrer: input.referrer ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      utmTerm: input.utmTerm ?? null,
      utmContent: input.utmContent ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      browser: input.browser ?? null,
      os: input.os ?? null,
      device: input.device ?? null,
      country: input.country?.slice(0, 2)?.toUpperCase() ?? null,
      sessionId: sessionIdHash.slice(0, 64),
      visitorIdHash: visitorIdHash.slice(0, 64),
      yearMonthDay,
      metadata,
    });

    this.appLogger.info('analytics.website.event', {
      type: input.type,
      page: input.page,
      utmCampaign: input.utmCampaign,
    });
  }

  async getStats(dateRange: DateRange): Promise<WebsiteStats> {
    const fromDate = toIsoDate(dateRange.from);
    const toDate = toIsoDate(dateRange.to);

    const [overview, conversions, byPage, byCountry, byDevice, byTrafficSource] = await Promise.all(
      [
        this.repo.getOverview(fromDate, toDate),
        this.repo.getConversionsByType(fromDate, toDate),
        this.repo.getTopPages(fromDate, toDate, 20),
        this.repo.getByCountry(fromDate, toDate, 20),
        this.repo.getByDevice(fromDate, toDate, 10),
        this.repo.getTrafficSources(fromDate, toDate, 20),
      ],
    );

    return {
      totalVisitors: overview.uniqueVisitors,
      uniqueVisitors: overview.uniqueVisitors,
      pageViews: overview.totalViews,
      sessions: overview.sessions,
      byPage,
      byCountry,
      byDevice,
      byTrafficSource,
      conversions: {
        contactFormSubmissions: (conversions.contact_click ?? 0) + (conversions.form_submit ?? 0),
        demoRequests: conversions.demo_click ?? 0,
        appDownloadClicks: conversions.app_download_click ?? 0,
        pricingViews: conversions.pricing_view ?? 0,
      },
    };
  }

  async getFunnel(dateRange: DateRange): Promise<FunnelData> {
    const fromDate = toIsoDate(dateRange.from);
    const toDate = toIsoDate(dateRange.to);
    const counts = await this.repo.getFunnelCounts(fromDate, toDate);
    const { visitors, pricingViewers, inquirers, downloaders } = counts;

    const safePct = (num: number, den: number): number =>
      den > 0 ? Math.round((num / den) * 10_000) / 100 : 0;

    return {
      steps: [
        {
          name: 'Visitors',
          count: visitors,
          conversionRate: 100,
          dropoffRate: 0,
        },
        {
          name: 'Viewed Pricing',
          count: pricingViewers,
          conversionRate: safePct(pricingViewers, visitors),
          dropoffRate: safePct(visitors - pricingViewers, visitors),
        },
        {
          name: 'Inquired',
          count: inquirers,
          conversionRate: safePct(inquirers, pricingViewers),
          dropoffRate: safePct(pricingViewers - inquirers, pricingViewers),
        },
        {
          name: 'Downloaded App',
          count: downloaders,
          conversionRate: safePct(downloaders, inquirers),
          dropoffRate: safePct(inquirers - downloaders, inquirers),
        },
      ],
      totalVisitors: visitors,
      totalConversions: downloaders,
      overallConversion: safePct(downloaders, visitors),
    };
  }

  async getTopPages(dateRange: DateRange, limit = 20): Promise<PageStat[]> {
    return this.repo.getTopPages(toIsoDate(dateRange.from), toIsoDate(dateRange.to), limit);
  }

  async getTrafficSources(dateRange: DateRange, limit = 20): Promise<TrafficSource[]> {
    return this.repo.getTrafficSources(toIsoDate(dateRange.from), toIsoDate(dateRange.to), limit);
  }

  /**
   * Pull the salt from `process.env`. We deliberately do not pre-cache
   * it on the constructor — rotating the salt at runtime needs to take
   * effect on the next request, not on the next process restart.
   */
  private getSalt(): string {
    return process.env.ANALYTICS_HASH_SALT ?? '';
  }

  /** Used by tests so they don't have to mock `process.env`. */
  static hashVisitorId(value: string, salt: string): string {
    return sha256WithSalt(value, salt);
  }
}
