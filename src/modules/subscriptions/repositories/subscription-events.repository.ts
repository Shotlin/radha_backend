import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewSubscriptionEvent,
  SubscriptionEventRow,
  subscriptionEvents,
} from '@/db/schema/subscription-events';

/**
 * BE-28 — `subscription_events` (append-only).
 *
 * Mirrors the `grn_events` pattern from BE-26: only `create` and
 * `find*` are exposed; events are never updated or deleted.
 */
@Injectable()
export class SubscriptionEventsRepository extends BaseRepository<
  typeof subscriptionEvents,
  SubscriptionEventRow,
  NewSubscriptionEvent,
  Partial<NewSubscriptionEvent>
> {
  constructor(db: DbService) {
    super(db.getDb(), subscriptionEvents, 'subscription_events');
  }

  async findByTenant(tenantId: string, limit = 100): Promise<SubscriptionEventRow[]> {
    return (await this.db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.tenantId, tenantId))
      .orderBy(desc(subscriptionEvents.createdAt))
      .limit(limit)) as SubscriptionEventRow[];
  }

  async findBySubscription(
    subscriptionId: string,
    tenantId: string,
  ): Promise<SubscriptionEventRow[]> {
    return (await this.db
      .select()
      .from(subscriptionEvents)
      .where(
        and(
          eq(subscriptionEvents.subscriptionId, subscriptionId),
          eq(subscriptionEvents.tenantId, tenantId),
        ),
      )
      .orderBy(desc(subscriptionEvents.createdAt))) as SubscriptionEventRow[];
  }
}
