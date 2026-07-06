import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  affiliateRevenue,
  type AffiliateRevenueRow,
  type NewAffiliateRevenue,
} from '@/db/schema/affiliate';

/**
 * BE-41 — Affiliate revenue Drizzle repository.
 *
 * Stores partner-reported revenue events (typically a webhook). The
 * Owner Dashboard aggregates these per partner / per day.
 */
@Injectable()
export class AffiliateRevenueRepository {
  constructor(private readonly db: DbService) {}

  async create(data: NewAffiliateRevenue): Promise<AffiliateRevenueRow> {
    const [row] = await this.db.getDb().insert(affiliateRevenue).values(data).returning();
    return row;
  }

  /**
   * Total reported revenue (paise) for a partner, optionally bounded
   * by a `[since, until)` window. Returns 0 when no rows match.
   */
  async sumByPartner(partnerId: string, since?: Date, until?: Date): Promise<number> {
    const conditions = [eq(affiliateRevenue.partnerId, partnerId)];
    if (since) conditions.push(gte(affiliateRevenue.reportedAt, since));
    if (until) conditions.push(lte(affiliateRevenue.reportedAt, until));
    const rows = await this.db
      .getDb()
      .select({ total: sql<number>`COALESCE(SUM(${affiliateRevenue.amountPaise}), 0)::int` })
      .from(affiliateRevenue)
      .where(and(...conditions));
    return rows[0]?.total ?? 0;
  }

  /**
   * Revenue grouped by partner. Used by the Owner Dashboard summary
   * widget.
   */
  async aggregateByPartner(
    since?: Date,
    until?: Date,
  ): Promise<{ partnerId: string; totalPaise: number }[]> {
    const conditions = [];
    if (since) conditions.push(gte(affiliateRevenue.reportedAt, since));
    if (until) conditions.push(lte(affiliateRevenue.reportedAt, until));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const builder = this.db
      .getDb()
      .select({
        partnerId: affiliateRevenue.partnerId,
        totalPaise: sql<number>`COALESCE(SUM(${affiliateRevenue.amountPaise}), 0)::int`,
      })
      .from(affiliateRevenue);

    const rows = where
      ? await builder.where(where).groupBy(affiliateRevenue.partnerId)
      : await builder.groupBy(affiliateRevenue.partnerId);
    return rows;
  }
}
