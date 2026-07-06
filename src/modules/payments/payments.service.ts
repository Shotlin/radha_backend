import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  BusinessException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';
import { RazorpayService } from '@/integrations/razorpay/razorpay.service';
import { UsersRepository } from '@/modules/auth/repositories/users.repository';
import { DAY_PASS_PRICING } from '@/modules/subscriptions/constants/default-plans';
import { PlansRepository } from '@/modules/subscriptions/repositories/plans.repository';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';
import type { PlanCode } from '@/modules/subscriptions/types/subscription.types';
import { AuditLogService } from '@/observability/audit-log.service';

import type { CheckoutInput, CheckoutResult } from './dto/checkout.dto';
import type { RefundInputDto, RefundResult } from './dto/refund.dto';
import type { VerifyPaymentInputDto, VerifyPaymentResult } from './dto/verify-payment.dto';
import {
  RazorpayWebhookEnvelopeSchema,
  type RazorpayWebhookEnvelope,
  type WebhookProcessResult,
} from './dto/webhook-payload.dto';
import { PaymentsRepository } from './payments.repository';

const RESOURCE_ORDER = 'RazorpayOrder';
const RESOURCE_REFUND = 'RazorpayRefund';
const RESOURCE_WEBHOOK = 'RazorpayWebhook';

interface AuthenticatedActor {
  userId: string;
  tenantId: string | null;
  ip?: string;
  userAgent?: string;
}

/**
 * BE-28 v2 — Payments service.
 *
 * Owns the Razorpay business logic. Composes:
 *   - `PaymentsRepository`     — order ledger + webhook inbox.
 *   - `RazorpayService`        — SDK / mock dispatcher.
 *   - `PlansRepository`        — plan price + code lookup.
 *   - `SubscriptionsService`   — promotes the tenant subscription
 *                                from trial → active after a
 *                                successful verify / capture.
 *   - `AuditLogService`        — every mutation lands in audit_logs.
 *
 * Constraints honoured:
 *   - HMAC verification uses `crypto.timingSafeEqual` (in the
 *     provider).
 *   - Webhook handler is fully idempotent (event_id unique +
 *     processed_at flag).
 *   - Razorpay SDK calls live exclusively in
 *     `integrations/razorpay/`; this service only consumes the
 *     `RazorpayService` façade.
 *   - Methods stay under 80 lines via private helpers.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly repo: PaymentsRepository,
    private readonly razorpay: RazorpayService,
    private readonly plansRepo: PlansRepository,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    private readonly users: UsersRepository,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  /* ─────────────────── Checkout ─────────────────── */

  async createCheckout(input: CheckoutInput, actor: AuthenticatedActor): Promise<CheckoutResult> {
    const plan = await this.plansRepo.findById(input.planId);
    if (!plan) throw new DomainNotFoundException('SubscriptionPlan', input.planId);

    const packType = input.packType ?? 'monthly';
    const amountPaise =
      packType === 'day_pass'
        ? this.computeDayPassAmountPaise(plan.code as PlanCode)
        : this.computeAmountPaise(plan.price, plan.yearlyPrice, input.billingCycle);
    const receipt = `radha_${actor.userId.slice(0, 8)}_${Date.now()}`;
    const notes = {
      planCode: plan.code,
      billingCycle: input.billingCycle,
      packType,
      tenantId: actor.tenantId ?? '',
      userId: actor.userId,
    };

    const order = await this.razorpay.createOrder({
      amountPaise,
      currency: 'INR',
      receipt,
      notes,
    });

    await this.repo.createOrder({
      tenantId: actor.tenantId,
      userId: actor.userId,
      planId: plan.id,
      razorpayOrderId: order.id,
      amountPaise,
      currency: 'INR',
      status: 'created',
      notes,
    });

    await this.auditLog.logAction({
      action: 'CREATE',
      resourceType: RESOURCE_ORDER,
      resourceId: order.id,
      userId: actor.userId,
      tenantId: actor.tenantId ?? 'system',
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
      success: true,
      metadata: {
        planCode: plan.code,
        billingCycle: input.billingCycle,
        amountPaise,
        provider: this.razorpay.providerName,
      },
    });

    const prefill = await this.buildPrefill(actor.userId);
    return {
      razorpayOrderId: order.id,
      keyId: this.config.payments.keyId,
      amountPaise,
      currency: 'INR',
      prefill,
      notes,
    };
  }

  /* ─────────────────── Verification ─────────────────── */

  async verifyPayment(
    input: VerifyPaymentInputDto,
    actor: AuthenticatedActor,
  ): Promise<VerifyPaymentResult> {
    const order = await this.repo.findOrderForActor(input.razorpayOrderId, {
      userId: actor.userId,
      tenantId: actor.tenantId,
    });
    if (!order) throw new DomainNotFoundException(RESOURCE_ORDER, input.razorpayOrderId);

    const result = this.razorpay.verifyPaymentSignature(input);
    if (!result.valid) {
      await this.recordVerifyFailure(order.id, input.razorpayOrderId, actor, 'invalid_signature');
      throw new BusinessException(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'Razorpay signature verification failed',
      );
    }

    const updated = await this.repo.updateOrderStatus(order.id, 'captured', {
      razorpayPaymentId: input.razorpayPaymentId,
      postedAt: new Date(),
    });

    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE_ORDER,
      resourceId: input.razorpayOrderId,
      userId: actor.userId,
      tenantId: actor.tenantId ?? 'system',
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
      success: true,
      metadata: {
        transition: 'verified',
        razorpayPaymentId: input.razorpayPaymentId,
        provider: this.razorpay.providerName,
      },
    });

    const subscription = await this.activateSubscriptionForOrder(
      order.tenantId,
      order.planId,
      this.packTypeOf(order.notes),
      { userId: actor.userId, tenantId: actor.tenantId },
    );

    return {
      ok: true,
      razorpayOrderId: input.razorpayOrderId,
      status: updated?.status ?? 'captured',
      subscription,
    };
  }

  /* ─────────────────── Refund ─────────────────── */

  async refundPayment(input: RefundInputDto, actor: AuthenticatedActor): Promise<RefundResult> {
    const order = await this.repo.findOrderByPaymentId(input.razorpayPaymentId);
    if (!order) throw new DomainNotFoundException(RESOURCE_REFUND, input.razorpayPaymentId);

    if (actor.tenantId && order.tenantId && order.tenantId !== actor.tenantId) {
      throw new DomainForbiddenException(
        'You can only refund payments on your own tenant',
        ErrorCode.TENANT_ACCESS_DENIED,
      );
    }
    if (order.status !== 'captured') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Cannot refund order in status='${order.status}'`,
      );
    }

    const refund = await this.razorpay.createRefund({
      paymentId: input.razorpayPaymentId,
      amountPaise: input.amountPaise,
      reason: input.reason,
    });

    await this.repo.updateOrderStatus(order.id, 'refunded', { refundedAt: new Date() });

    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE_REFUND,
      resourceId: input.razorpayPaymentId,
      userId: actor.userId,
      tenantId: actor.tenantId ?? 'system',
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
      success: true,
      metadata: {
        refundId: refund.id,
        amountPaise: refund.amountPaise || order.amountPaise,
        reason: input.reason,
        provider: this.razorpay.providerName,
      },
    });

    return {
      ok: true,
      razorpayPaymentId: input.razorpayPaymentId,
      refundId: refund.id,
      status: refund.status,
      amountPaise: refund.amountPaise || order.amountPaise,
    };
  }

  /* ─────────────────── Webhook ─────────────────── */

  async handleWebhook(
    rawBody: string,
    signature: string,
    parsed: unknown,
  ): Promise<WebhookProcessResult> {
    if (!this.razorpay.verifyWebhookSignature({ rawBody, signature })) {
      throw new BusinessException(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'Razorpay webhook signature verification failed',
      );
    }

    const envelope = this.parseWebhookEnvelope(parsed);
    const eventId = envelope.id ?? `synthetic-${randomUUID()}`;
    const { row, duplicate } = await this.repo.recordInboxEvent({
      provider: 'razorpay',
      eventId,
      eventType: envelope.event,
      payload: parsed as Record<string, unknown>,
      signature,
    });

    if (duplicate) {
      this.logger.log(`razorpay.webhook.duplicate event=${envelope.event} eventId=${eventId}`);
      return { ok: true, duplicate: true, event: envelope.event, inboxId: row.id };
    }

    try {
      await this.applyWebhookSideEffects(envelope);
      await this.repo.markInboxProcessed(row.id, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      await this.repo.markInboxProcessed(row.id, message);
      this.logger.error('razorpay.webhook.process_failed', {
        event: envelope.event,
        eventId,
        message,
      });
      // Swallow the error — webhook processing failures are recorded
      // for replay; we always return 200 so Razorpay stops retrying
      // if the failure is deterministic. The replay job picks up
      // rows where `processed_at` is set with a non-null
      // `processing_error`.
    }

    return { ok: true, duplicate: false, event: envelope.event, inboxId: row.id };
  }

  /* ─────────────────── Internals ─────────────────── */

  private computeAmountPaise(
    monthlyPrice: string,
    yearlyPrice: string | null,
    cycle: 'monthly' | 'yearly',
  ): number {
    const raw = cycle === 'yearly' ? (yearlyPrice ?? monthlyPrice) : monthlyPrice;
    const rupees = Number.parseFloat(raw);
    if (!Number.isFinite(rupees) || rupees < 0) {
      throw new BusinessException(ErrorCode.BUSINESS_RULE_VIOLATION, 'Plan price is invalid');
    }
    const paise = Math.round(rupees * 100);
    if (paise < 100) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Plan amount must be at least ₹1',
      );
    }
    return paise;
  }

  /**
   * Day-pass amounts (₹3/₹5/₹9) are deliberately below the ₹1 floor check
   * in `computeAmountPaise` only in the sense that they're small — they're
   * still >= ₹1, so no floor exception is needed. Reads from
   * `DAY_PASS_PRICING` (default-plans.ts) rather than the plan's own
   * `price`/`yearlyPrice` columns, since those hold the recurring monthly
   * amount, not the one-time day-pass price.
   */
  private computeDayPassAmountPaise(planCode: PlanCode): number {
    const rupees = DAY_PASS_PRICING[planCode];
    if (rupees === undefined) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Plan '${planCode}' has no 1-day pass`,
      );
    }
    return Math.round(rupees * 100);
  }

  private async buildPrefill(userId: string): Promise<CheckoutResult['prefill']> {
    const user = await this.users.findById(userId);
    return {
      name: user?.name ?? '',
      email: user?.email ?? '',
      contact: user?.mobile ?? '',
    };
  }

  private async recordVerifyFailure(
    orderId: string,
    razorpayOrderId: string,
    actor: AuthenticatedActor,
    reason: string,
  ): Promise<void> {
    await this.repo.updateOrderStatus(orderId, 'failed', { failedAt: new Date() });
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE_ORDER,
      resourceId: razorpayOrderId,
      userId: actor.userId,
      tenantId: actor.tenantId ?? 'system',
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
      success: false,
      errorCode: ErrorCode.PAYMENT_PROVIDER_ERROR,
      metadata: { reason, provider: this.razorpay.providerName },
    });
  }

  private async activateSubscriptionForOrder(
    tenantId: string | null,
    planId: string,
    packType: 'monthly' | 'day_pass',
    actor: { userId: string; tenantId: string | null },
  ): Promise<VerifyPaymentResult['subscription']> {
    if (!tenantId) {
      // Consumer-tier purchase before personal tenant bootstrap —
      // BE-09 v2 wires that up. We record the order; the
      // bootstrap flow will activate the subscription when the
      // tenant is created.
      return undefined;
    }
    const plan = await this.plansRepo.findById(planId);
    if (!plan) return undefined;
    try {
      const updated =
        packType === 'day_pass'
          ? await this.subscriptions.activateDayPass(tenantId, plan.code as PlanCode, actor.userId)
          : await this.subscriptions.upgradeToPlan(tenantId, plan.code as PlanCode, actor.userId);
      return { tenantId, planCode: updated.planCode };
    } catch (err) {
      this.logger.error('payments.subscription_activation.failed', {
        tenantId,
        planCode: plan.code,
        packType,
        message: err instanceof Error ? err.message : 'unknown',
      });
      return undefined;
    }
  }

  /** Reads `packType` back off the order's `notes` JSONB — defaults to
   * `'monthly'` for orders created before this field existed. */
  private packTypeOf(notes: Record<string, unknown> | null): 'monthly' | 'day_pass' {
    return notes?.packType === 'day_pass' ? 'day_pass' : 'monthly';
  }

  private parseWebhookEnvelope(parsed: unknown): RazorpayWebhookEnvelope {
    const result = RazorpayWebhookEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      throw new BusinessException(
        ErrorCode.VALIDATION_ERROR,
        'Razorpay webhook payload is malformed',
      );
    }
    return result.data;
  }

  private async applyWebhookSideEffects(envelope: RazorpayWebhookEnvelope): Promise<void> {
    switch (envelope.event) {
      case 'payment.captured':
      case 'order.paid':
        await this.applyCaptureEvent(envelope);
        return;
      case 'payment.failed':
        await this.applyFailureEvent(envelope);
        return;
      case 'refund.processed':
        await this.applyRefundEvent(envelope);
        return;
      default:
        // Anything else stays in the inbox without side-effects.
        this.logger.log(`razorpay.webhook.ignored event=${envelope.event}`);
    }
  }

  private async applyCaptureEvent(envelope: RazorpayWebhookEnvelope): Promise<void> {
    const orderId =
      envelope.payload.payment?.entity.order_id ?? envelope.payload.order?.entity.id;
    if (!orderId) return;
    const order = await this.repo.findOrderByRazorpayId(orderId);
    if (!order) return;
    if (order.status === 'captured' || order.status === 'refunded') return;

    await this.repo.updateOrderStatus(order.id, 'captured', {
      razorpayPaymentId: envelope.payload.payment?.entity.id ?? order.razorpayPaymentId,
      postedAt: new Date(),
    });
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE_WEBHOOK,
      resourceId: orderId,
      userId: 'system',
      tenantId: order.tenantId ?? 'system',
      success: true,
      metadata: { transition: 'captured', event: envelope.event },
    });
    if (order.tenantId) {
      await this.activateSubscriptionForOrder(
        order.tenantId,
        order.planId,
        this.packTypeOf(order.notes),
        { userId: 'system', tenantId: order.tenantId },
      );
    }
  }

  private async applyFailureEvent(envelope: RazorpayWebhookEnvelope): Promise<void> {
    const orderId = envelope.payload.payment?.entity.order_id;
    if (!orderId) return;
    const order = await this.repo.findOrderByRazorpayId(orderId);
    if (!order || order.status === 'captured' || order.status === 'refunded') return;
    await this.repo.updateOrderStatus(order.id, 'failed', { failedAt: new Date() });
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE_WEBHOOK,
      resourceId: orderId,
      userId: 'system',
      tenantId: order.tenantId ?? 'system',
      success: true,
      metadata: { transition: 'failed', event: envelope.event },
    });
  }

  private async applyRefundEvent(envelope: RazorpayWebhookEnvelope): Promise<void> {
    const paymentId = envelope.payload.refund?.entity.payment_id;
    if (!paymentId) return;
    const order = await this.repo.findOrderByPaymentId(paymentId);
    if (!order || order.status === 'refunded') return;
    await this.repo.updateOrderStatus(order.id, 'refunded', { refundedAt: new Date() });
    await this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE_WEBHOOK,
      resourceId: paymentId,
      userId: 'system',
      tenantId: order.tenantId ?? 'system',
      success: true,
      metadata: { transition: 'refunded', event: envelope.event },
    });
  }
}
