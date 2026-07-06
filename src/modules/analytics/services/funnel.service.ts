import { Injectable } from '@nestjs/common';

import { MarketingLeadsRepository } from '../repositories/marketing-leads.repository';
import { WebsiteEventsRepository } from '../repositories/website-events.repository';
import type { DateRange, FunnelData } from '../types/analytics.types';
import { toIsoDate } from '../utils/date-range.util';

/**
 * BE-29 — Conversion funnel.
 *
 * Pure read service. Combines website-event signals (visitors →
 * pricing → inquiry) with the lead conversion outcome to produce a
 * single normalized funnel object the dashboards can render.
 */
@Injectable()
export class FunnelService {
  constructor(
    private readonly websiteRepo: WebsiteEventsRepository,
    private readonly leadsRepo: MarketingLeadsRepository,
  ) {}

  async getFullFunnel(dateRange: DateRange): Promise<FunnelData> {
    const fromDate = toIsoDate(dateRange.from);
    const toDate = toIsoDate(dateRange.to);

    const [website, leads] = await Promise.all([
      this.websiteRepo.getFunnelCounts(fromDate, toDate),
      this.leadsRepo.getConversionStats(dateRange.from, dateRange.to),
    ]);

    const visitors = website.visitors;
    const pricingViewers = website.pricingViewers;
    const inquirers = Math.max(website.inquirers, leads.totalLeads);
    const converted = leads.converted;

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
          name: 'Converted',
          count: converted,
          conversionRate: safePct(converted, inquirers),
          dropoffRate: safePct(inquirers - converted, inquirers),
        },
      ],
      totalVisitors: visitors,
      totalConversions: converted,
      overallConversion: safePct(converted, visitors),
    };
  }
}
