import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';

import { AppUsageEventsRepository } from '../repositories/app-usage-events.repository';
import { MarketingLeadsRepository } from '../repositories/marketing-leads.repository';
import { OwnerDailyMetricsRepository } from '../repositories/owner-daily-metrics.repository';
import { WebsiteEventsRepository } from '../repositories/website-events.repository';
import { endOfUtcDay, startOfUtcDay, toIsoDate } from '../utils/date-range.util';

/**
 * BE-29 — Owner-metrics aggregator.
 *
 * Pulls a day's worth of platform-wide KPIs and upserts a single row
 * into `owner_daily_metrics`. Idempotent: re-running for the same day
 * overwrites the existing row via the unique-`date` constraint.
 *
 * Cross-table queries against `tenant_subscriptions`, `scan_items`,
 * `reports`, and `ai_usage_log` use raw `db.execute(sql...)` and
 * check `to_regclass()` first so a partially-migrated dev environment
 * doesn't break aggregation — missing tables simply zero out the
 * corresponding KPI for that day.
 */
@Injectable()
export class OwnerMetricsAggregatorService {
  constructor(
    private readonly db: DbService,
    private readonly websiteRepo: WebsiteEventsRepository,
    private readonly leadsRepo: MarketingLeadsRepository,
    private readonly appEventsRepo: AppUsageEventsRepository,
    private readonly metricsRepo: OwnerDailyMetricsRepository,
    private readonly logger: LoggerService,
  ) {}

  async aggregateForDate(date: Date): Promise<{ date: string; mrr: string; dau: number }> {
    const start = startOfUtcDay(date);
    const end = endOfUtcDay(date);
    const dateStr = toIsoDate(start);

    this.logger.info('analytics.aggregator.start', { date: dateStr });

    const [website, leads, tenants, plans, usage, dau, mau, mrr] = await Promise.all([
      this.websiteForDay(dateStr),
      this.leadsForDay(start, end),
      this.tenantSubscriptionsForDay(start, end),
      this.planDistribution(),
      this.usageForDay(dateStr),
      this.appEventsRepo.countDistinctUsersOnDay(dateStr),
      this.computeMau(start),
      this.computeMrr(),
    ]);

    const row = await this.metricsRepo.upsert({
      date: start,
      websiteVisitors: website.visitors,
      websitePageViews: website.pageViews,
      websiteContactClicks: website.contactClicks,
      websitePricingViews: website.pricingViews,
      websiteAppDownloadClicks: website.appDownloadClicks,

      newLeads: leads.newLeads,
      qualifiedLeads: leads.qualifiedLeads,
      convertedLeads: leads.convertedLeads,

      newTenants: tenants.newTenants,
      activeTenants: tenants.activeTenants,
      trialTenants: tenants.trialTenants,
      paidTenants: tenants.paidTenants,
      cancelledTenants: tenants.cancelledTenants,

      starterCount: plans.starter,
      growthCount: plans.growth,
      proCount: plans.pro,

      mrr,
      newMrr: '0',
      churnedMrr: '0',

      totalScans: usage.scans,
      totalReports: usage.reports,
      totalAiCalls: usage.aiCalls,
      totalEanValidations: 0,

      dau,
      mau,

      aiCost: '0',
      smsCost: '0',
      s3Cost: '0',
    });

    this.logger.info('analytics.aggregator.done', {
      date: dateStr,
      rowId: row.id,
      mrr,
      dau,
    });

    return { date: dateStr, mrr, dau };
  }

  /* ────────── Website ────────── */

  private async websiteForDay(dateStr: string) {
    const r = await this.db.getDb().execute(sql`
      SELECT
        COUNT(DISTINCT visitor_id_hash) FILTER (WHERE type = 'page_view')::int AS visitors,
        COUNT(*)                          FILTER (WHERE type = 'page_view')::int AS page_views,
        COUNT(*) FILTER (WHERE type = 'contact_click')::int      AS contact_clicks,
        COUNT(*) FILTER (WHERE type = 'pricing_view')::int       AS pricing_views,
        COUNT(*) FILTER (WHERE type = 'app_download_click')::int AS app_download_clicks
      FROM website_events
      WHERE year_month_day = ${dateStr}
    `);
    const row = this.firstRow(r);
    return {
      visitors: this.numField(row, 'visitors'),
      pageViews: this.numField(row, 'page_views'),
      contactClicks: this.numField(row, 'contact_clicks'),
      pricingViews: this.numField(row, 'pricing_views'),
      appDownloadClicks: this.numField(row, 'app_download_clicks'),
    };
  }

  /* ────────── Leads ────────── */

  private async leadsForDay(from: Date, to: Date) {
    const [newLeads, qualifiedLeads, convertedLeads] = await Promise.all([
      this.leadsRepo.countCreatedBetween(from, to),
      this.leadsRepo.countQualifiedBetween(from, to),
      this.leadsRepo.countConvertedBetween(from, to),
    ]);
    return { newLeads, qualifiedLeads, convertedLeads };
  }

  /* ────────── Tenants / subscriptions ────────── */

  private async tenantSubscriptionsForDay(from: Date, to: Date) {
    const exists = await this.tableExists('tenant_subscriptions');
    if (!exists) {
      return {
        newTenants: 0,
        activeTenants: 0,
        trialTenants: 0,
        paidTenants: 0,
        cancelledTenants: 0,
      };
    }
    const r = await this.db.getDb().execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${from} AND created_at < ${to})::int AS new_tenants,
        COUNT(*) FILTER (WHERE status IN ('active', 'trial'))::int                 AS active_tenants,
        COUNT(*) FILTER (WHERE status = 'trial')::int                              AS trial_tenants,
        COUNT(*) FILTER (WHERE status = 'active')::int                             AS paid_tenants,
        COUNT(*) FILTER (
          WHERE status = 'cancelled' AND cancelled_at >= ${from} AND cancelled_at < ${to}
        )::int                                                                      AS cancelled_tenants
      FROM tenant_subscriptions
    `);
    const row = this.firstRow(r);
    return {
      newTenants: this.numField(row, 'new_tenants'),
      activeTenants: this.numField(row, 'active_tenants'),
      trialTenants: this.numField(row, 'trial_tenants'),
      paidTenants: this.numField(row, 'paid_tenants'),
      cancelledTenants: this.numField(row, 'cancelled_tenants'),
    };
  }

  private async planDistribution() {
    const exists = await this.tableExists('tenant_subscriptions');
    const dist: Record<string, number> = { starter: 0, growth: 0, pro: 0 };
    if (!exists) return dist;
    const r = await this.db.getDb().execute(sql`
      SELECT plan_code, COUNT(*)::int AS count
      FROM tenant_subscriptions
      WHERE status = 'active'
      GROUP BY plan_code
    `);
    for (const row of this.allRows(r)) {
      const code = String(row.plan_code ?? '');
      if (code in dist) dist[code] = this.numField(row, 'count');
    }
    return dist;
  }

  private async computeMrr(): Promise<string> {
    const exists = await this.tableExists('tenant_subscriptions');
    if (!exists) return '0';
    const r = await this.db.getDb().execute(sql`
      SELECT COALESCE(SUM(monthly_amount), 0)::text AS mrr
      FROM tenant_subscriptions
      WHERE status = 'active'
    `);
    const row = this.firstRow(r);
    return String(row.mrr ?? '0');
  }

  /* ────────── Usage ────────── */

  private async usageForDay(dateStr: string) {
    const [scansExists, reportsExists, aiExists] = await Promise.all([
      this.tableExists('scan_items'),
      this.tableExists('reports'),
      this.tableExists('ai_usage_log'),
    ]);

    const scans = scansExists
      ? this.numField(
          this.firstRow(
            await this.db.getDb().execute(sql`
              SELECT COUNT(*)::int AS count FROM scan_items
              WHERE TO_CHAR(scanned_at, 'YYYY-MM-DD') = ${dateStr}
            `),
          ),
          'count',
        )
      : 0;

    const reports = reportsExists
      ? this.numField(
          this.firstRow(
            await this.db.getDb().execute(sql`
              SELECT COUNT(*)::int AS count FROM reports
              WHERE TO_CHAR(created_at, 'YYYY-MM-DD') = ${dateStr}
            `),
          ),
          'count',
        )
      : 0;

    const aiCalls = aiExists
      ? this.numField(
          this.firstRow(
            await this.db.getDb().execute(sql`
              SELECT COUNT(*)::int AS count FROM ai_usage_log
              WHERE year_month_day = ${dateStr}
            `),
          ),
          'count',
        )
      : 0;

    return { scans, reports, aiCalls };
  }

  /* ────────── Active users ────────── */

  private async computeMau(dayStart: Date): Promise<number> {
    const monthStart = new Date(
      Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    return this.appEventsRepo.countDistinctUsersBetween(monthStart, dayStart);
  }

  /* ────────── Helpers ────────── */

  private async tableExists(table: string): Promise<boolean> {
    const r = await this.db.getDb().execute(sql`
      SELECT to_regclass(${table}) AS exists
    `);
    const row = this.firstRow(r);
    return row.exists !== null && row.exists !== undefined;
  }

  private firstRow(result: unknown): Record<string, unknown> {
    const rows = this.allRows(result);
    return rows[0] ?? {};
  }

  private allRows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    if (result && typeof result === 'object' && 'rows' in result) {
      const r = (result as { rows?: unknown }).rows;
      if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
    }
    return [];
  }

  private numField(row: Record<string, unknown>, key: string): number {
    const v = row[key];
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
}
