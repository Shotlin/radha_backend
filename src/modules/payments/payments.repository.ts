import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewPaymentWebhookInbox,
  PaymentWebhookInboxRow,
  paymentWebhooksInbox,
} from '@/db/schema/payment-webhooks-inbox';
import {
  NewRazorpayOrder,
  RazorpayOrderRow,
  RazorpayOrderStatus,
  razorpayOrders,
} from '@/db/schema/razorpay-orders';

/**
 * BE-28 v2 — Drizzle data access for the payments domain.
 *
 * Two tables sit under this repository:
 *   - `razorpay_orders`         — the merchant-side order ledger.
 *   - `payment_webhooks_inbox`  — webhook idempotency anchor.
 *
 * Every multi-tenant lookup includes `tenant_id`. Consumer-tier
 * payments where the user has no tenant yet use the
 * `findOrderByRazorpayId` accessor which is keyed only on the
 * provider id (the unique constraint guarantees safety) but the
 * tenant-scoped helpers are what the service uses for any
 * authenticated mutation.
 */
@Injectable()
export class PaymentsRepository extends BaseRepository<
  typeof razorpayOrders,
  RazorpayOrderRow,
  NewRazorpayOrder,
  Partial<NewRazorpayOrder>
> {
  constructor(private readonly dbService: DbService) {
    super(dbService.getDb(), razorpayOrders, 'razorpay_orders');
  }

  /* ─────────────────── razorpay_orders ─────────────────── */

  async createOrder(data: NewRazorpayOrder): Promise<RazorpayOrderRow> {
    return this.create(data);
  }

  async findOrderByRazorpayId(razorpayOrderId: string): Promise<RazorpayOrderRow | null> {
    const [row] = await this.db
      .select()
      .from(razorpayOrders)
      .where(eq(razorpayOrders.razorpayOrderId, razorpayOrderId))
      .limit(1);
    return (row as RazorpayOrderRow | undefined) ?? null;
  }

  /**
   * Tenant-scoped lookup. Used by the verify endpoint so a user can
   * never confirm a payment that belongs to a different tenant.
   * `tenantId` may legitimately be null for consumer-tier purchases;
   * in that case we match on `user_id` only.
   */
  async findOrderForActor(
    razorpayOrderId: string,
    actor: { userId: string; tenantId: string | null },
  ): Promise<RazorpayOrderRow | null> {
    const conditions = [eq(razorpayOrders.razorpayOrderId, razorpayOrderId)];
    if (actor.tenantId) {
      conditions.push(eq(razorpayOrders.tenantId, actor.tenantId));
    } else {
      conditions.push(isNull(razorpayOrders.tenantId));
      conditions.push(eq(razorpayOrders.userId, actor.userId));
    }
    const [row] = await this.db
      .select()
      .from(razorpayOrders)
      .where(and(...conditions))
      .limit(1);
    return (row as RazorpayOrderRow | undefined) ?? null;
  }

  async updateOrderStatus(
    id: string,
    status: RazorpayOrderStatus,
    patch: Partial<NewRazorpayOrder> = {},
  ): Promise<RazorpayOrderRow | null> {
    const [row] = await this.db
      .update(razorpayOrders)
      .set({
        ...patch,
        status,
        updatedAt: new Date(),
      } as never)
      .where(eq(razorpayOrders.id, id))
      .returning();
    return (row as RazorpayOrderRow | undefined) ?? null;
  }

  async findOrderByPaymentId(razorpayPaymentId: string): Promise<RazorpayOrderRow | null> {
    const [row] = await this.db
      .select()
      .from(razorpayOrders)
      .where(eq(razorpayOrders.razorpayPaymentId, razorpayPaymentId))
      .limit(1);
    return (row as RazorpayOrderRow | undefined) ?? null;
  }

  /* ─────────────────── payment_webhooks_inbox ─────────────────── */

  /**
   * Insert-or-find on `event_id`. Returns `{ row, duplicate }` so
   * the service can short-circuit duplicate deliveries with a 200.
   * Implementation uses `ON CONFLICT DO NOTHING` so the unique
   * constraint provides race-safe idempotency.
   */
  async recordInboxEvent(
    data: NewPaymentWebhookInbox,
  ): Promise<{ row: PaymentWebhookInboxRow; duplicate: boolean }> {
    const [inserted] = await this.db
      .insert(paymentWebhooksInbox)
      .values(data as never)
      .onConflictDoNothing({ target: paymentWebhooksInbox.eventId })
      .returning();
    if (inserted) {
      return { row: inserted as PaymentWebhookInboxRow, duplicate: false };
    }
    const [existing] = await this.db
      .select()
      .from(paymentWebhooksInbox)
      .where(eq(paymentWebhooksInbox.eventId, data.eventId))
      .limit(1);
    return { row: existing as PaymentWebhookInboxRow, duplicate: true };
  }

  async markInboxProcessed(
    id: string,
    error: string | null = null,
  ): Promise<PaymentWebhookInboxRow | null> {
    const [row] = await this.db
      .update(paymentWebhooksInbox)
      .set({
        processedAt: new Date(),
        processingError: error,
      } as never)
      .where(eq(paymentWebhooksInbox.id, id))
      .returning();
    return (row as PaymentWebhookInboxRow | undefined) ?? null;
  }
}
