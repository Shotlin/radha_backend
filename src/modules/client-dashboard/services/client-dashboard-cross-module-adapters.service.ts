import { Injectable } from '@nestjs/common';

import { InventoryAccuracyMetricsQuery } from '@/modules/inventory/queries/inventory-accuracy-metrics.query';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

import type {
  IInventoryAccuracyMetricsQuery,
  ISubscriptionsService,
  InventoryAccuracyMetrics,
  InventoryAccuracyMetricsInput,
  SubscriptionStatus,
} from '../types/integration.tokens';

/**
 * BE-30 ↔ BE-27/BE-28 adapters.
 *
 * The client-dashboard module declares narrow read-only ports
 * (`IInventoryAccuracyMetricsQuery`, `ISubscriptionsService`) so the
 * dashboard can boot before the sibling phases landed. Now that
 * BE-27 and BE-28 are both built, these adapters bridge the ports to
 * the real implementations and replace the in-process stubs.
 *
 * Previously the stubs returned:
 *   - zero inventory accuracy (varianceRate: 0, countsPerformed: 0)
 *   - a fake 90-day trial plan with all features enabled
 * — meaning the OHS Inventory Accuracy signal was permanently zero
 * and the subscription card always showed "trial". Both gaps close
 * with these adapters.
 */

@Injectable()
export class ClientDashboardInventoryAccuracyAdapterService
  implements IInventoryAccuracyMetricsQuery
{
  constructor(private readonly query: InventoryAccuracyMetricsQuery) {}

  async getMetrics(input: InventoryAccuracyMetricsInput): Promise<InventoryAccuracyMetrics> {
    // `asOf` is not forwarded — the real query always computes against
    // `new Date()`. The windowDays parameter is honoured.
    return this.query.forStore(input.tenantId, input.storeId, input.windowDays);
  }
}

@Injectable()
export class ClientDashboardSubscriptionsAdapterService implements ISubscriptionsService {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  async getStatus(tenantId: string): Promise<SubscriptionStatus> {
    const result = await this.subscriptions.getStatus(tenantId);

    // Map the richer SubscriptionStatusResult to the dashboard's
    // narrower SubscriptionStatus shape.
    const byFeature: SubscriptionStatus['usage']['byFeature'] = {};
    for (const [feature, stats] of Object.entries(result.usage.byFeature)) {
      if (!stats) continue;
      const isUnlimited = stats.limit === 'unlimited';
      const blocked = !isUnlimited && stats.used >= (stats.limit as number);
      byFeature[feature] = {
        percentageUsed: stats.percentageUsed,
        ...(blocked && { blocked: true, reason: 'Monthly limit reached' }),
      };
    }

    const lifecycleStatus = this.mapStatus(result.status);

    return {
      status: lifecycleStatus,
      plan: { code: result.plan.code, name: result.plan.name },
      ...(result.trialDaysRemaining !== undefined && {
        trialDaysRemaining: result.trialDaysRemaining,
      }),
      usage: { byFeature },
    };
  }

  private mapStatus(
    s: string,
  ): SubscriptionStatus['status'] {
    const valid = new Set(['trial', 'active', 'past_due', 'cancelled', 'expired']);
    return valid.has(s) ? (s as SubscriptionStatus['status']) : 'active';
  }
}
