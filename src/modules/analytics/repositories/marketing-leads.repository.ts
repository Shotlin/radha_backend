import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { decodeCursor, encodeCursor } from '@/db/repositories/pagination.utils';
import {
  type MarketingLeadRow,
  marketingLeads,
  type NewMarketingLead,
} from '@/db/schema/marketing-leads';

import type { ListLeadsFilter } from '../types/lead.types';

/**
 * BE-29 — `marketing_leads` data access.
 */
@Injectable()
export class MarketingLeadsRepository extends BaseRepository<
  typeof marketingLeads,
  MarketingLeadRow,
  NewMarketingLead,
  Partial<NewMarketingLead>
> {
  constructor(db: DbService) {
    super(db.getDb(), marketingLeads, 'marketing_leads');
  }

  async listPaginated(filters: ListLeadsFilter): Promise<{
    data: MarketingLeadRow[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const conditions = [sql`${marketingLeads.deletedAt} IS NULL`];

    if (filters.status) conditions.push(eq(marketingLeads.status, filters.status));
    if (filters.source) conditions.push(eq(marketingLeads.source, filters.source));
    if (filters.utmCampaign) conditions.push(eq(marketingLeads.utmCampaign, filters.utmCampaign));

    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (decoded && typeof decoded.createdAt === 'string' && typeof decoded.id === 'string') {
        conditions.push(
          sql`(${marketingLeads.createdAt}, ${marketingLeads.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
        );
      }
    }

    const rows = (await this.db
      .select()
      .from(marketingLeads)
      .where(and(...conditions))
      .orderBy(desc(marketingLeads.createdAt), desc(marketingLeads.id))
      .limit(limit + 1)) as MarketingLeadRow[];

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id }, [
            { field: 'createdAt', direction: 'desc' },
            { field: 'id', direction: 'desc' },
          ])
        : null;

    return { data, nextCursor, hasMore };
  }

  async findActiveByEmailRecent(email: string, sinceMs: number): Promise<MarketingLeadRow | null> {
    const since = new Date(Date.now() - sinceMs);
    const [row] = await this.db
      .select()
      .from(marketingLeads)
      .where(
        and(
          eq(marketingLeads.email, email.toLowerCase()),
          gte(marketingLeads.createdAt, since),
          sql`${marketingLeads.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(marketingLeads.createdAt))
      .limit(1);
    return (row as MarketingLeadRow | undefined) ?? null;
  }

  async getConversionStats(
    from: Date,
    to: Date,
  ): Promise<{
    totalLeads: number;
    contacted: number;
    qualified: number;
    converted: number;
    lost: number;
    spam: number;
  }> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(*)::int AS total_leads,
        COUNT(*) FILTER (WHERE status IN ('contacted','qualified','demo_scheduled','demo_completed','converted'))::int AS contacted,
        COUNT(*) FILTER (WHERE status IN ('qualified','demo_scheduled','demo_completed','converted'))::int AS qualified,
        COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
        COUNT(*) FILTER (WHERE status = 'lost')::int      AS lost,
        COUNT(*) FILTER (WHERE status = 'spam')::int      AS spam
      FROM marketing_leads
      WHERE created_at >= ${from}
        AND created_at <  ${to}
        AND deleted_at IS NULL
    `);
    const row = this.rows(result)[0] ?? {};
    return {
      totalLeads: Number(row.total_leads ?? 0),
      contacted: Number(row.contacted ?? 0),
      qualified: Number(row.qualified ?? 0),
      converted: Number(row.converted ?? 0),
      lost: Number(row.lost ?? 0),
      spam: Number(row.spam ?? 0),
    };
  }

  async countCreatedBetween(from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingLeads)
      .where(
        and(
          gte(marketingLeads.createdAt, from),
          lt(marketingLeads.createdAt, to),
          sql`${marketingLeads.deletedAt} IS NULL`,
        ),
      );
    return Number(row?.count ?? 0);
  }

  async countQualifiedBetween(from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingLeads)
      .where(
        and(
          eq(marketingLeads.status, 'qualified'),
          gte(marketingLeads.updatedAt, from),
          lte(marketingLeads.updatedAt, to),
          sql`${marketingLeads.deletedAt} IS NULL`,
        ),
      );
    return Number(row?.count ?? 0);
  }

  async countConvertedBetween(from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingLeads)
      .where(
        and(
          eq(marketingLeads.status, 'converted'),
          gte(marketingLeads.convertedAt, from),
          lte(marketingLeads.convertedAt, to),
          sql`${marketingLeads.deletedAt} IS NULL`,
        ),
      );
    return Number(row?.count ?? 0);
  }

  private rows(result: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    if (result && typeof result === 'object' && 'rows' in result) {
      const r = (result as { rows?: unknown }).rows;
      if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
    }
    return [];
  }
}
