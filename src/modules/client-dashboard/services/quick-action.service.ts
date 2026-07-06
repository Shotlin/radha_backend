import { Inject, Injectable } from '@nestjs/common';

import { RequestContextService } from '@/common/context/request-context.service';

import type { QuickAction } from '../types/dashboard.types';
import {
  SUBSCRIPTIONS_SERVICE_TOKEN,
  type ISubscriptionsService,
  type SubscriptionStatus,
} from '../types/integration.tokens';

/**
 * BE-30 — Quick-action surfacing for the dashboard.
 *
 * Returns a fixed set of action shortcuts plus an `enabled` flag
 * driven by the BE-28 subscription status. Each action references a
 * feature key in `subscription.usage.byFeature`; if the tenant has
 * hit a limit (`blocked = true`), the action goes disabled and the
 * mobile app shows the upgrade prompt with the supplied `reason`.
 *
 * Trial users start with everything enabled; the stub
 * SubscriptionsService returns an empty `byFeature` map which keeps
 * all six actions live until BE-28 ships its real metering.
 *
 * The result is intentionally deterministic — same inputs produce
 * the same output — so the dashboard cache can serialise it safely.
 */
@Injectable()
export class QuickActionService {
  constructor(
    private readonly context: RequestContextService,
    @Inject(SUBSCRIPTIONS_SERVICE_TOKEN)
    private readonly subscriptions: ISubscriptionsService,
  ) {}

  async getQuickActions(_storeId: string, _userId: string): Promise<QuickAction[]> {
    const tenantId = this.context.getTenantId();
    const status: SubscriptionStatus | null = tenantId
      ? await this.subscriptions.getStatus(tenantId).catch(() => null)
      : null;

    const usage = status?.usage.byFeature ?? {};
    const blockedFor = (key: string): { enabled: boolean; reason?: string } => {
      const entry = usage[key];
      if (entry?.blocked) {
        return { enabled: false, reason: entry.reason ?? 'Feature limit reached' };
      }
      return { enabled: true };
    };

    const ai = blockedFor('ai_ocr_uses');
    const reports = blockedFor('report_generation');
    const grn = blockedFor('grn_creation');

    return [
      buildAction('qa-scan', 'scan', 'Scan Product', 'qr_code_scanner', { enabled: true }),
      buildAction('qa-add-product', 'add_product', 'Add Product', 'add_box', ai),
      buildAction('qa-create-grn', 'create_grn', 'New GRN', 'receipt_long', grn),
      buildAction('qa-create-task', 'create_task', 'Assign Task', 'assignment', { enabled: true }),
      buildAction('qa-view-alerts', 'view_alerts', 'View Alerts', 'notifications_active', {
        enabled: true,
      }),
      buildAction(
        'qa-generate-report',
        'generate_report',
        'Generate Report',
        'description',
        reports,
      ),
    ];
  }
}

/** Build a quick action and strip `reason` when enabled to keep payloads clean. */
function buildAction(
  id: string,
  type: QuickAction['type'],
  label: string,
  icon: string,
  state: { enabled: boolean; reason?: string },
): QuickAction {
  if (state.enabled) {
    return { id, type, label, icon, enabled: true };
  }
  return { id, type, label, icon, enabled: false, reason: state.reason };
}
