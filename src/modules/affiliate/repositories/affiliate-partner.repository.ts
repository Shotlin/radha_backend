import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  affiliatePartners,
  type AffiliatePartnerRow,
  type NewAffiliatePartner,
} from '@/db/schema/affiliate';

/**
 * BE-41 — Affiliate partner Drizzle repository.
 *
 * Pure data-access; no business logic. Service callers decide
 * activeness, fallback ordering, and link rendering.
 */
@Injectable()
export class AffiliatePartnerRepository {
  constructor(private readonly db: DbService) {}

  async findById(id: string): Promise<AffiliatePartnerRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(affiliatePartners)
      .where(eq(affiliatePartners.id, id));
    return rows[0] ?? null;
  }

  async findByName(name: string): Promise<AffiliatePartnerRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(affiliatePartners)
      .where(eq(affiliatePartners.name, name));
    return rows[0] ?? null;
  }

  async findActive(): Promise<AffiliatePartnerRow[]> {
    return this.db
      .getDb()
      .select()
      .from(affiliatePartners)
      .where(eq(affiliatePartners.isActive, true))
      .orderBy(affiliatePartners.name);
  }

  async findActiveByName(name: string): Promise<AffiliatePartnerRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(affiliatePartners)
      .where(and(eq(affiliatePartners.name, name), eq(affiliatePartners.isActive, true)));
    return rows[0] ?? null;
  }

  async create(data: NewAffiliatePartner): Promise<AffiliatePartnerRow> {
    const [row] = await this.db.getDb().insert(affiliatePartners).values(data).returning();
    return row;
  }

  async setActive(id: string, isActive: boolean): Promise<AffiliatePartnerRow | null> {
    const [row] = await this.db
      .getDb()
      .update(affiliatePartners)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(affiliatePartners.id, id))
      .returning();
    return row ?? null;
  }
}
