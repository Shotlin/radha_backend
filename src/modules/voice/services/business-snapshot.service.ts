import { Injectable } from '@nestjs/common';

import { ExpiryService } from '@/modules/expiry/expiry.service';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { TasksService } from '@/modules/tasks/tasks.service';

import { BusinessSnapshot } from '../types/voice.types';

/** How many days ahead the "expiring soon" line looks. */
const NEAR_EXPIRY_DAYS_AHEAD = 7;
/** Cap on named products in the prompt — keeps the snapshot cheap to send
 * and the spoken answer from turning into a product-name list-recital. */
const NEAR_EXPIRY_ROW_LIMIT = 8;

/**
 * Assembles a compact snapshot of one store's live business data by calling
 * the same domain services the app's own screens already use — in-process,
 * not over HTTP. (`GET /api/v1/dashboard/kpis` looked like the obvious
 * source, but `ClientDashboardModule` is never imported in `app.module.ts`
 * — that whole controller is dead code at runtime. `ExpiryService`,
 * `TasksService`, and `InventoryService` are all genuinely registered and
 * exported, so this calls them directly instead.)
 *
 * Each fetch is independently `.catch(() => null)`: one dead subsystem
 * degrades a single line of the eventual answer, never the whole turn.
 * This is also what makes the deterministic template fallback
 * (`voice-template-answer.ts`) possible when the LLM itself is down — the
 * real data is already in hand before the LLM is ever called.
 */
@Injectable()
export class BusinessSnapshotService {
  constructor(
    private readonly expiryService: ExpiryService,
    private readonly tasksService: TasksService,
    private readonly inventoryService: InventoryService,
  ) {}

  async build(tenantId: string, storeId: string): Promise<BusinessSnapshot> {
    const [expiryStats, nearExpiry, taskStats, inventorySummary] = await Promise.all([
      this.expiryService.getStoreStats(tenantId, storeId).catch(() => null),
      this.expiryService
        .list(tenantId, {
          storeId,
          daysAhead: NEAR_EXPIRY_DAYS_AHEAD,
          limit: NEAR_EXPIRY_ROW_LIMIT,
        })
        .catch(() => []),
      this.tasksService.getStats(tenantId, { storeId }).catch(() => null),
      this.inventoryService.getStoreSummary(tenantId, storeId).catch(() => null),
    ]);

    return {
      storeId,
      generatedAt: new Date(),
      expiryStats,
      nearExpiry,
      taskStats,
      inventorySummary,
    };
  }
}
