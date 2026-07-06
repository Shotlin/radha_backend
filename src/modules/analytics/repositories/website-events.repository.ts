import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  type NewWebsiteEvent,
  type WebsiteEventRow,
  websiteEvents,
} from '@/db/schema/website-events';

/**
 * BE-29 — `website_events` data access.
 *
 * Wraps `BaseRepository` for vanilla CRUD and adds the aggregation
 * SQL used by `WebsiteAnalyticsService`. All queries filter by the
 * pre-computed `year_month_day` column so they hit the date index.
 */
@Injectable()
export class WebsiteEventsRepository extends BaseRepository<
  typeof websiteEvents,
  WebsiteEventRow,
  NewWebsiteEvent,
  Partial<NewWebsiteEvent>
> {
  constructor(db: DbService) {
    super(db.getDb(), websiteEvents, 'website_events');
  }

  async getOverview(
    fromDate: string,
    toDate: string,
  ): Promise<{ totalViews: number; uniqueVisitors: number; sessions: number }> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(*)::int                                         AS total_views,
        COUNT(DISTINCT visitor_id_hash)::int                  AS unique_visitors,
        COUNT(DISTINCT session_id)::int                       AS sessions
      FROM website_events
      WHERE year_month_day BETWEEN ${fromDate} AND ${toDate}
        AND type = 'page_view'
    `);
    const row = this.rows(result)[0] ?? {};
    return {
      totalViews: Number(row.total_views ?? 0),
      uniqueVisitors: Number(row.unique_visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    };
  }

  async getConversionsByType(fromDate: string, toDate: string): Promise<Record<string, number>> {
    const result = await this.db.execute(sql`
      SELECT type, COUNT(*)::int AS count
      FROM website_events
      WHERE year_month_day BETWEEN ${fromDate} AND ${toDate}
        AND type IN ('contact_click', 'demo_click', 'app_download_click', 'pricing_view', 'form_submit')
      GROUP BY type
    `);
    const out: Record<string, number> = {};
    for (const r of this.rows(result)) {
      out[String(r.type)] = Number(r.count ?? 0);
    }
    return out;
  }

  async getTopPages(
    fromDate: string,
    toDate: string,
    limit: number,
  ): Promise<Array<{ page: string; views: number; uniqueVisitors: number }>> {
    const result = await this.db.execute(sql`
      SELECT page,
             COUNT(*)::int                                AS views,
             COUNT(DISTINCT visitor_id_hash)::int         AS unique_visitors
      FROM website_events
      WHERE year_month_day BETWEEN ${fromDate} AND ${toDate}
        AND type = 'page_view'
        AND page IS NOT NULL
      GROUP BY page
      ORDER BY views DESC
      LIMIT ${limit}
    `);
    return this.rows(result).map((r) => ({
      page: String(r.page ?? ''),
      views: Number(r.views ?? 0),
      uniqueVisitors: Number(r.unique_visitors ?? 0),
    }));
  }

  async getByCountry(
    fromDate: string,
    toDate: string,
    limit = 20,
  ): Promise<Array<{ country: string; visitors: number }>> {
    const result = await this.db.execute(sql`
      SELECT country, COUNT(DISTINCT visitor_id_hash)::int AS visitors
      FROM website_events
      WHERE year_month_day BETWEEN ${fromDate} AND ${toDate}
        AND country IS NOT NULL
      GROUP BY country
      ORDER BY visitors DESC
      LIMIT ${limit}
    `);
    return this.rows(result).map((r) => ({
      country: String(r.country ?? ''),
      visitors: Number(r.visitors ?? 0),
    }));
  }

  async getByDevice(
    fromDate: string,
    toDate: string,
    limit = 10,
  ): Promise<Array<{ device: string; count: number }>> {
    const result = await this.db.execute(sql`
      SELECT device, COUNT(DISTINCT visitor_id_hash)::int AS count
      FROM website_events
      WHERE year_month_day BETWEEN ${fromDate} AND ${toDate}
        AND device IS NOT NULL
      GROUP BY device
      ORDER BY count DESC
      LIMIT ${limit}
    `);
    return this.rows(result).map((r) => ({
      device: String(r.device ?? ''),
      count: Number(r.count ?? 0),
    }));
  }

  async getTrafficSources(
    fromDate: string,
    toDate: string,
    limit = 20,
  ): Promise<Array<{ source: string; visitors: number }>> {
    const result = await this.db.execute(sql`
      SELECT COALESCE(utm_source, 'direct') AS source,
             COUNT(DISTINCT visitor_id_hash)::int AS visitors
      FROM website_events
      WHERE year_month_day BETWEEN ${fromDate} AND ${toDate}
      GROUP BY 1
      ORDER BY visitors DESC
      LIMIT ${limit}
    `);
    return this.rows(result).map((r) => ({
      source: String(r.source ?? 'direct'),
      visitors: Number(r.visitors ?? 0),
    }));
  }

  async getFunnelCounts(
    fromDate: string,
    toDate: string,
  ): Promise<{
    visitors: number;
    pricingViewers: number;
    inquirers: number;
    downloaders: number;
  }> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(DISTINCT CASE WHEN type = 'page_view'           THEN visitor_id_hash END)::int AS visitors,
        COUNT(DISTINCT CASE WHEN type = 'pricing_view'        THEN visitor_id_hash END)::int AS pricing_viewers,
        COUNT(DISTINCT CASE WHEN type = 'app_download_click'  THEN visitor_id_hash END)::int AS downloaders,
        COUNT(DISTINCT CASE WHEN type IN ('contact_click', 'demo_click', 'form_submit') THEN visitor_id_hash END)::int AS inquirers
      FROM website_events
      WHERE year_month_day BETWEEN ${fromDate} AND ${toDate}
    `);
    const row = this.rows(result)[0] ?? {};
    return {
      visitors: Number(row.visitors ?? 0),
      pricingViewers: Number(row.pricing_viewers ?? 0),
      inquirers: Number(row.inquirers ?? 0),
      downloaders: Number(row.downloaders ?? 0),
    };
  }

  async countByVisitorHash(hash: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(websiteEvents)
      .where(and(eq(websiteEvents.visitorIdHash, hash)));
    return Number(row?.count ?? 0);
  }

  /**
   * `postgres-js` returns rows as a plain array on the result; some
   * Drizzle versions wrap that as `{ rows }`. Handle both.
   */
  private rows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    if (result && typeof result === 'object' && 'rows' in result) {
      const r = (result as { rows?: unknown }).rows;
      if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
    }
    return [];
  }
}
