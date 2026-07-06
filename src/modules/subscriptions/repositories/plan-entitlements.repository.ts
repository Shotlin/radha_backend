import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewPlanEntitlement,
  PlanEntitlementRow,
  planEntitlements,
} from '@/db/schema/plan-entitlements';

/**
 * BE-28 — `plan_entitlements` data access.
 *
 * The hot read path is `findByPlanAndFeature` — called on every
 * entitlement check. Plans never grow huge, but the unique
 * `(plan_id, feature)` index makes this an O(1) lookup.
 */
@Injectable()
export class PlanEntitlementsRepository extends BaseRepository<
  typeof planEntitlements,
  PlanEntitlementRow,
  NewPlanEntitlement,
  Partial<NewPlanEntitlement>
> {
  constructor(db: DbService) {
    super(db.getDb(), planEntitlements, 'plan_entitlements');
  }

  async findByPlan(planId: string): Promise<PlanEntitlementRow[]> {
    return (await this.db
      .select()
      .from(planEntitlements)
      .where(eq(planEntitlements.planId, planId))) as PlanEntitlementRow[];
  }

  async findByPlanAndFeature(planId: string, feature: string): Promise<PlanEntitlementRow | null> {
    const [row] = await this.db
      .select()
      .from(planEntitlements)
      .where(and(eq(planEntitlements.planId, planId), eq(planEntitlements.feature, feature)))
      .limit(1);
    return (row as PlanEntitlementRow | undefined) ?? null;
  }

  /**
   * Seed-time upsert. Uses the unique `(plan_id, feature)` index to
   * detect existing rows and patch them in-place so re-running the
   * seed is safe.
   */
  async upsertByPlanAndFeature(data: NewPlanEntitlement): Promise<PlanEntitlementRow> {
    const existing = await this.findByPlanAndFeature(data.planId, data.feature);
    if (existing) {
      const [row] = await this.db
        .update(planEntitlements)
        .set({ ...data, updatedAt: new Date() } as never)
        .where(eq(planEntitlements.id, existing.id))
        .returning();
      return row as PlanEntitlementRow;
    }
    const [row] = await this.db
      .insert(planEntitlements)
      .values(data as never)
      .returning();
    return row as PlanEntitlementRow;
  }

  async deleteByPlan(planId: string): Promise<number> {
    const rows = await this.db
      .delete(planEntitlements)
      .where(eq(planEntitlements.planId, planId))
      .returning({ id: planEntitlements.id });
    return rows.length;
  }
}
