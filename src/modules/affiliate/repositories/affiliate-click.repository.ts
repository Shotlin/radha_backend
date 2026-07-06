import { Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  affiliateClicks,
  type AffiliateClickRow,
  type NewAffiliateClick,
} from '@/db/schema/affiliate';

/**
 * BE-41 — Affiliate click Drizzle repository.
 *
 * Click rows intentionally store NO PII — only the user id reference,
 * the EAN pair, the partner id, and a timestamp. IPs / user agents
 * stay in the request log only.
 */
@Injectable()
export class AffiliateClickRepository {
  constructor(private readonly db: DbService) {}

  async create(data: NewAffiliateClick): Promise<AffiliateClickRow> {
    const [row] = await this.db.getDb().insert(affiliateClicks).values(data).returning();
    return row;
  }

  async findById(id: string): Promise<AffiliateClickRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(affiliateClicks)
      .where(eq(affiliateClicks.id, id));
    return rows[0] ?? null;
  }

  async countByPartner(partnerId: string, since?: Date): Promise<number> {
    const where = since
      ? and(eq(affiliateClicks.partnerId, partnerId), gte(affiliateClicks.clickedAt, since))
      : eq(affiliateClicks.partnerId, partnerId);
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(affiliateClicks)
      .where(where);
    return rows[0]?.count ?? 0;
  }
}
