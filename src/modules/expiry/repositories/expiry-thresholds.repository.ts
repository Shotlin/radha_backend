import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { ExpiryThresholdRow, NewExpiryThreshold, expiryThresholds } from '@/db/schema/expiry';

@Injectable()
export class ExpiryThresholdsRepository extends BaseRepository<
  typeof expiryThresholds,
  ExpiryThresholdRow,
  NewExpiryThreshold,
  Partial<NewExpiryThreshold>
> {
  constructor(db: DbService) {
    super(db.getDb(), expiryThresholds, 'expiry_thresholds');
  }

  /** Tenant-specific row first, falls back to the global default row. */
  async findEffective(category: string, tenantId: string): Promise<ExpiryThresholdRow | null> {
    const [tenantRow] = await this.db
      .select()
      .from(expiryThresholds)
      .where(and(eq(expiryThresholds.tenantId, tenantId), eq(expiryThresholds.category, category)))
      .limit(1);
    if (tenantRow) return tenantRow as ExpiryThresholdRow;

    const [globalRow] = await this.db
      .select()
      .from(expiryThresholds)
      .where(and(isNull(expiryThresholds.tenantId), eq(expiryThresholds.category, category)))
      .limit(1);
    return (globalRow as ExpiryThresholdRow | undefined) ?? null;
  }

  async listForTenant(tenantId: string, category?: string): Promise<ExpiryThresholdRow[]> {
    const conditions = [eq(expiryThresholds.tenantId, tenantId)];
    if (category) conditions.push(eq(expiryThresholds.category, category));
    return (await this.db
      .select()
      .from(expiryThresholds)
      .where(and(...conditions))) as ExpiryThresholdRow[];
  }

  async upsertForTenant(
    tenantId: string,
    userId: string,
    data: { category: string; yellowDays: number; redDays: number },
  ): Promise<ExpiryThresholdRow> {
    const [row] = await this.db
      .insert(expiryThresholds)
      .values({
        tenantId,
        category: data.category,
        yellowDays: data.yellowDays,
        redDays: data.redDays,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [expiryThresholds.tenantId, expiryThresholds.category],
        set: {
          yellowDays: data.yellowDays,
          redDays: data.redDays,
          updatedBy: userId,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row as ExpiryThresholdRow;
  }

  async upsertGlobalDefault(data: {
    category: string;
    yellowDays: number;
    redDays: number;
  }): Promise<ExpiryThresholdRow> {
    const [row] = await this.db
      .insert(expiryThresholds)
      .values({
        tenantId: null,
        category: data.category,
        yellowDays: data.yellowDays,
        redDays: data.redDays,
      })
      .onConflictDoUpdate({
        target: [expiryThresholds.tenantId, expiryThresholds.category],
        set: {
          yellowDays: data.yellowDays,
          redDays: data.redDays,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row as ExpiryThresholdRow;
  }
}
