import { Injectable, Logger } from '@nestjs/common';

import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';

import { SubscriptionsRepository } from '../repositories/subscriptions.repository';
import { FamilySharingService } from './family-sharing.service';

/**
 * BE-36 — Premium Consumer subscription service.
 *
 * Handles subscribe and cancel flows for the ₹49/mo Premium Consumer
 * tier. Uses a mocked RBI eMandate payment gateway for mandate
 * creation and disabling.
 *
 * On cancellation, all derived family-sharing entitlements are revoked.
 */

/** Mocked mandate response shape. */
interface MandateResult {
  reference: string;
  status: 'active' | 'failed';
}

@Injectable()
export class PremiumConsumerService {
  private readonly logger = new Logger(PremiumConsumerService.name);

  constructor(
    private readonly db: DbService,
    private readonly subsRepo: SubscriptionsRepository,
    private readonly familySharing: FamilySharingService,
  ) {}

  /**
   * Subscribe to Premium Consumer tier (₹49/mo).
   *
   * 1. Validate no active premium_consumer subscription exists.
   * 2. Setup RBI eMandate (mocked).
   * 3. Create subscription record.
   * 4. Emit analytics event.
   */
  async subscribe(
    userId: string,
    tenantId: string,
    paymentMethodToken: string,
  ): Promise<{
    subscriptionId: string;
    tier: string;
    emandateReference: string;
    nextRenewalAt: Date;
  }> {
    // Check for existing active subscription
    const existing = await this.subsRepo.findByTenant(tenantId);
    if (existing && existing.planCode === 'premium_consumer' && existing.status === 'active') {
      throw new DomainConflictException(
        'Already subscribed to Premium Consumer tier',
        ErrorCode.CONFLICT,
      );
    }

    // Mock RBI eMandate setup
    const mandate = await this.setupMandate(userId, paymentMethodToken);
    if (mandate.status !== 'active') {
      throw new BusinessException(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'Failed to setup eMandate. Please try again.',
      );
    }

    const nextRenewalAt = new Date();
    nextRenewalAt.setDate(nextRenewalAt.getDate() + 30);

    // Create or update subscription
    const now = new Date();
    if (existing) {
      const updated = await this.subsRepo.updateByTenant(tenantId, {
        planCode: 'premium_consumer',
        status: 'active',
        monthlyAmount: '49',
        paymentMethod: `emandate:${mandate.reference}`,
        currentPeriodStart: now,
        currentPeriodEnd: nextRenewalAt,
        nextBillingDate: nextRenewalAt,
        cancelledAt: null,
        cancellationReason: null,
        metadata: { emandateReference: mandate.reference, tier: 'premium_consumer' },
      });

      this.logger.log(
        `Premium Consumer subscription activated for tenant=${tenantId}, user=${userId}`,
      );

      return {
        subscriptionId: updated!.id,
        tier: 'premium_consumer',
        emandateReference: mandate.reference,
        nextRenewalAt,
      };
    }

    // Should not normally happen since tenant onboarding creates a sub,
    // but handle gracefully
    throw new DomainNotFoundException('TenantSubscription', tenantId);
  }

  /**
   * Cancel Premium Consumer subscription at period end.
   *
   * 1. Validate active premium_consumer subscription exists.
   * 2. Disable mandate.
   * 3. Mark subscription as cancelled (active until period end).
   * 4. Revoke all family-sharing derived entitlements.
   */
  async cancel(
    userId: string,
    tenantId: string,
  ): Promise<{ cancelledAt: Date; activeUntil: Date }> {
    const sub = await this.subsRepo.findByTenant(tenantId);
    if (!sub || sub.planCode !== 'premium_consumer' || sub.status !== 'active') {
      throw new DomainNotFoundException('Active Premium Consumer subscription', tenantId);
    }

    // Disable eMandate
    const emandateRef = (sub.metadata as Record<string, unknown>)?.emandateReference as string;
    if (emandateRef) {
      await this.disableMandate(emandateRef);
    }

    const now = new Date();
    await this.subsRepo.updateByTenant(tenantId, {
      cancelledAt: now,
      cancellationReason: 'User requested cancellation',
      status: 'cancelled',
      metadata: { ...((sub.metadata as Record<string, unknown>) ?? {}), cancelAtPeriodEnd: true },
    });

    // Revoke all family sharing derived entitlements
    await this.familySharing.revokeAllDerivedFromPrimary(userId);

    this.logger.log(
      `Premium Consumer subscription cancelled for tenant=${tenantId}, user=${userId}`,
    );

    return {
      cancelledAt: now,
      activeUntil: sub.currentPeriodEnd,
    };
  }

  /* ─────────────────── Payment Gateway (Mocked) ─────────────────── */

  /**
   * Mock RBI eMandate setup.
   * In production, this calls the payment provider's API to register
   * a recurring mandate with max amount ₹4900 paise.
   */
  private async setupMandate(
    _userId: string,
    _paymentMethodToken: string,
  ): Promise<MandateResult> {
    // Mock: always succeeds with a generated reference
    const reference = `MNDT_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return { reference, status: 'active' };
  }

  /**
   * Mock mandate disable.
   * In production, this calls the payment provider's API to cancel
   * the recurring mandate.
   */
  private async disableMandate(reference: string): Promise<void> {
    this.logger.log(`eMandate disabled: ${reference}`);
    // Mock: no-op
  }
}
