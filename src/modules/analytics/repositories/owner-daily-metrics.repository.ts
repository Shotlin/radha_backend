import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  type NewOwnerDailyMetric,
  type OwnerDailyMetricRow,
  ownerDailyMetrics,
} from '@/db/schema/owner-daily-metrics';

/**
 * BE-29 — `owner_daily_metrics` upsert + read.
 *
 * Single insert path that the cron uses to either create or refresh
 * the row for a given UTC day.
 */
@Injectable()
export class OwnerDailyMetricsRepository extends BaseRepository<
  typeof ownerDailyMetrics,
  OwnerDailyMetricRow,
  NewOwnerDailyMetric,
  Partial<NewOwnerDailyMetric>
> {
  constructor(db: DbService) {
    super(db.getDb(), ownerDailyMetrics, 'owner_daily_metrics');
  }

  async upsert(row: NewOwnerDailyMetric): Promise<OwnerDailyMetricRow> {
    const [out] = await this.db
      .insert(ownerDailyMetrics)
      .values(row)
      .onConflictDoUpdate({
        target: ownerDailyMetrics.date,
        set: {
          websiteVisitors: row.websiteVisitors,
          websitePageViews: row.websitePageViews,
          websiteContactClicks: row.websiteContactClicks,
          websitePricingViews: row.websitePricingViews,
          websiteAppDownloadClicks: row.websiteAppDownloadClicks,
          newLeads: row.newLeads,
          qualifiedLeads: row.qualifiedLeads,
          convertedLeads: row.convertedLeads,
          newTenants: row.newTenants,
          activeTenants: row.activeTenants,
          trialTenants: row.trialTenants,
          paidTenants: row.paidTenants,
          cancelledTenants: row.cancelledTenants,
          starterCount: row.starterCount,
          growthCount: row.growthCount,
          proCount: row.proCount,
          mrr: row.mrr,
          newMrr: row.newMrr,
          churnedMrr: row.churnedMrr,
          totalScans: row.totalScans,
          totalReports: row.totalReports,
          totalAiCalls: row.totalAiCalls,
          totalEanValidations: row.totalEanValidations,
          dau: row.dau,
          mau: row.mau,
          aiCost: row.aiCost,
          smsCost: row.smsCost,
          s3Cost: row.s3Cost,
          metadata: row.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return out as OwnerDailyMetricRow;
  }
}
