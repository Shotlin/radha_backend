import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewSubscriptionPlan,
  SubscriptionPlanRow,
  subscriptionPlans,
} from '@/db/schema/subscription-plans';

/**
 * BE-28 — `subscription_plans` data access.
 *
 * Adds:
 *   - `findByCode`         : key lookup used by the trial start +
 *                            upgrade flows.
 *   - `listActive`         : `is_active=true`, optionally filter to
 *                            public-only for unauthenticated reads.
 *   - `upsertByCode`       : seed-friendly upsert keyed on `code`.
 */
@Injectable()
export class PlansRepository extends BaseRepository<
  typeof subscriptionPlans,
  SubscriptionPlanRow,
  NewSubscriptionPlan,
  Partial<NewSubscriptionPlan>
> {
  constructor(db: DbService) {
    super(db.getDb(), subscriptionPlans, 'subscription_plans');
  }

  async findByCode(code: string): Promise<SubscriptionPlanRow | null> {
    const [row] = await this.db
      .select()
      .from(subscriptionPlans)
      .where(and(eq(subscriptionPlans.code, code), isNull(subscriptionPlans.deletedAt)))
      .limit(1);
    return (row as SubscriptionPlanRow | undefined) ?? null;
  }

  async listActive(includePrivate = false): Promise<SubscriptionPlanRow[]> {
    const conds = [eq(subscriptionPlans.isActive, true), isNull(subscriptionPlans.deletedAt)];
    if (!includePrivate) conds.push(eq(subscriptionPlans.isPublic, true));
    return (await this.db
      .select()
      .from(subscriptionPlans)
      .where(and(...conds))
      .orderBy(asc(subscriptionPlans.sortOrder))) as SubscriptionPlanRow[];
  }

  async upsertByCode(data: NewSubscriptionPlan): Promise<SubscriptionPlanRow> {
    const existing = await this.findByCode(data.code);
    if (existing) {
      const [row] = await this.db
        .update(subscriptionPlans)
        .set({ ...data, updatedAt: new Date() } as never)
        .where(eq(subscriptionPlans.id, existing.id))
        .returning();
      return row as SubscriptionPlanRow;
    }
    const [row] = await this.db
      .insert(subscriptionPlans)
      .values(data as never)
      .returning();
    return row as SubscriptionPlanRow;
  }
}
