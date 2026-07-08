import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import {
  BatchDateObservationRow,
  NewBatchDateObservation,
  NewProductBatchConsensus,
  ProductBatchConsensusRow,
  batchDateObservations,
  productBatchConsensus,
} from '@/db/schema/batch-dates';

/**
 * BE-58 — Drizzle repository for the batch-dates tables. Pure data
 * access, no consensus logic (that's `consensus.ts`) and no HTTP
 * concerns (that's the service/controller).
 */
@Injectable()
export class BatchDatesRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Inserts one observation. Returns `null` when the same user has
   * already voted this exact (ean, batchCode, expiryDate) — the unique
   * index makes the repeat a no-op, and the caller (service) treats
   * `null` as "no new vote, but still recompute/return the current
   * consensus" (idempotent per spec).
   */
  async insertObservation(
    data: NewBatchDateObservation,
    tx: Transaction,
  ): Promise<BatchDateObservationRow | null> {
    const rows = await tx
      .insert(batchDateObservations)
      .values(data)
      .onConflictDoNothing({
        target: [
          batchDateObservations.userId,
          batchDateObservations.ean,
          batchDateObservations.batchCode,
          batchDateObservations.expiryDate,
        ],
      })
      .returning();
    return rows[0] ?? null;
  }

  async listObservations(
    ean: string,
    batchCode: string,
    tx?: Transaction,
  ): Promise<BatchDateObservationRow[]> {
    const scope = tx ?? this.db.getDb();
    return scope
      .select()
      .from(batchDateObservations)
      .where(
        and(
          eq(batchDateObservations.ean, ean),
          eq(batchDateObservations.batchCode, batchCode),
        ),
      );
  }

  async countObservationsByUserSince(userId: string, since: Date): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(batchDateObservations)
      .where(
        and(
          eq(batchDateObservations.userId, userId),
          sql`${batchDateObservations.createdAt} >= ${since}`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** Upserts the precomputed consensus row for (ean, batchCode). */
  async upsertConsensus(
    data: NewProductBatchConsensus,
    tx: Transaction,
  ): Promise<ProductBatchConsensusRow> {
    const rows = await tx
      .insert(productBatchConsensus)
      .values(data)
      .onConflictDoUpdate({
        target: [productBatchConsensus.ean, productBatchConsensus.batchCode],
        set: {
          consensusExpiry: data.consensusExpiry,
          consensusMfg: data.consensusMfg,
          confirmations: data.confirmations,
          distinctUsers: data.distinctUsers,
          confidence: data.confidence,
          status: data.status,
          updatedAt: new Date(),
        },
      })
      .returning();
    return rows[0];
  }

  async findConsensus(
    ean: string,
    batchCode: string,
  ): Promise<ProductBatchConsensusRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(productBatchConsensus)
      .where(
        and(
          eq(productBatchConsensus.ean, ean),
          eq(productBatchConsensus.batchCode, batchCode),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listConsensusForEan(ean: string): Promise<ProductBatchConsensusRow[]> {
    return this.db
      .getDb()
      .select()
      .from(productBatchConsensus)
      .where(eq(productBatchConsensus.ean, ean));
  }
}
