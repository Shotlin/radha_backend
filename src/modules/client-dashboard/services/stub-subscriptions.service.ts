import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import type { ISubscriptionsService, SubscriptionStatus } from '../types/integration.tokens';

/**
 * BE-30 — In-process stub for the BE-28 subscriptions service.
 *
 * BE-28 ships in the same wave as BE-30 and will own the real
 * `SubscriptionsService`. Until the orchestrator rebinds
 * `SUBSCRIPTIONS_SERVICE_TOKEN`, the dashboard quick-action service
 * and the subscription card fall through to this stub.
 *
 * Returns a 90-day trial with a `trial` plan code and an empty
 * usage map — equivalent to a freshly-onboarded tenant. The
 * dashboard renders correctly and quick actions stay enabled.
 *
 * The handoff doc lists this as deferred.
 */
@Injectable()
export class StubSubscriptionsService implements ISubscriptionsService {
  constructor(private readonly logger: LoggerService) {}

  async getStatus(tenantId: string): Promise<SubscriptionStatus> {
    this.logger.warn('dashboard.subscriptions.stub_used', {
      reason: 'BE-28 subscriptions module not yet wired',
      tenantId,
    });
    return {
      status: 'trial',
      plan: { code: 'trial' },
      trialDaysRemaining: 90,
      usage: { byFeature: {} },
    };
  }
}
