import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  BarcodeLearningFlagRow,
  NewBarcodeLearningFlag,
  barcodeLearningFlags,
} from '@/db/schema/barcode-learning';

/**
 * BE-56 — Drizzle repository for `barcode_learning_flags`.
 *
 * Pure data access. The `UNIQUE(product_ean, flagger_user_id)`
 * constraint at the DB layer means a single user spamming the
 * endpoint cannot inflate the flag count for an EAN.
 */
@Injectable()
export class FlagRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Insert a new flag. Returns the row when accepted; returns `null`
   * when the same user has already flagged this EAN (the unique
   * constraint ignores the duplicate). The caller treats `null` as
   * "no-op, count unchanged".
   */
  async create(data: NewBarcodeLearningFlag): Promise<BarcodeLearningFlagRow | null> {
    const rows = await this.db
      .getDb()
      .insert(barcodeLearningFlags)
      .values(data)
      .onConflictDoNothing({
        target: [barcodeLearningFlags.productEan, barcodeLearningFlags.flaggerUserId],
      })
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Count the unique flaggers for `ean`. Because `(product_ean,
   * flagger_user_id)` is unique we can `count(*)` and trust it.
   */
  async countUniqueByEan(ean: string): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(barcodeLearningFlags)
      .where(eq(barcodeLearningFlags.productEan, ean));
    return rows[0]?.count ?? 0;
  }
}
