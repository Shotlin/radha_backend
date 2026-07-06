import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewProductHealthAssessment,
  ProductHealthAssessmentRow,
  productHealthAssessments,
} from '@/db/schema/health-scoring';

/**
 * BE-12 — `product_health_assessments` repository.
 *
 * The hot path is `findLatest(productId, ruleVersion)` — a single
 * indexed lookup. Writes go through `upsert` which respects the
 * `(product_id, rule_version)` unique index.
 */
@Injectable()
export class HealthAssessmentsRepository extends BaseRepository<
  typeof productHealthAssessments,
  ProductHealthAssessmentRow,
  NewProductHealthAssessment,
  Partial<NewProductHealthAssessment>
> {
  constructor(db: DbService) {
    super(db.getDb(), productHealthAssessments, 'product_health_assessments');
  }

  async findByProductAndVersion(
    productId: string,
    ruleVersion: string,
  ): Promise<ProductHealthAssessmentRow | null> {
    const [row] = await this.db
      .select()
      .from(productHealthAssessments)
      .where(
        and(
          eq(productHealthAssessments.productId, productId),
          eq(productHealthAssessments.ruleVersion, ruleVersion),
        ),
      )
      .limit(1);
    return (row as ProductHealthAssessmentRow | undefined) ?? null;
  }

  async findLatestForProduct(productId: string): Promise<ProductHealthAssessmentRow | null> {
    const [row] = await this.db
      .select()
      .from(productHealthAssessments)
      .where(eq(productHealthAssessments.productId, productId))
      .orderBy(sql`${productHealthAssessments.computedAt} desc`)
      .limit(1);
    return (row as ProductHealthAssessmentRow | undefined) ?? null;
  }

  async upsert(data: NewProductHealthAssessment): Promise<ProductHealthAssessmentRow> {
    const [row] = await this.db
      .insert(productHealthAssessments)
      .values(data)
      .onConflictDoUpdate({
        target: [productHealthAssessments.productId, productHealthAssessments.ruleVersion],
        set: {
          overallGrade: data.overallGrade,
          overallScore: data.overallScore,
          healthStatus: data.healthStatus,
          childSafetyStatus: data.childSafetyStatus,
          childSafetyReasons: data.childSafetyReasons,
          isProcessed: data.isProcessed,
          warnings: data.warnings,
          positives: data.positives,
          allergens: data.allergens,
          tags: data.tags,
          ageBandSafety: data.ageBandSafety,
          consumptionGuidance: data.consumptionGuidance,
          inputSnapshot: data.inputSnapshot,
          computedAt: data.computedAt ?? sql`now()`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row as ProductHealthAssessmentRow;
  }

  async aggregateStats(): Promise<{
    total: number;
    byGrade: Record<string, number>;
    childSafe: number;
    ultraProcessed: number;
    withAllergens: number;
  }> {
    const rows = (await this.db
      .select({
        grade: productHealthAssessments.overallGrade,
        childSafetyStatus: productHealthAssessments.childSafetyStatus,
        isProcessed: productHealthAssessments.isProcessed,
        allergensCount: sql<number>`coalesce(jsonb_array_length(${productHealthAssessments.allergens}), 0)`,
      })
      .from(productHealthAssessments)) as Array<{
      grade: string;
      childSafetyStatus: string;
      isProcessed: string;
      allergensCount: number;
    }>;

    const byGrade: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, U: 0 };
    let childSafe = 0;
    let ultraProcessed = 0;
    let withAllergens = 0;
    for (const r of rows) {
      byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1;
      if (r.childSafetyStatus === 'suitable') childSafe++;
      if (r.isProcessed === 'ultra') ultraProcessed++;
      if (Number(r.allergensCount) > 0) withAllergens++;
    }
    return {
      total: rows.length,
      byGrade,
      childSafe,
      ultraProcessed,
      withAllergens,
    };
  }
}
