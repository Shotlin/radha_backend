import { Injectable } from '@nestjs/common';

import type { Transaction } from '@/db/connection';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { ProductsRepository } from '@/modules/products/products.repository';

import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { LowStockAlertsRepository } from '../repositories/low-stock-alerts.repository';
import { LowStockRulesRepository } from '../repositories/low-stock-rules.repository';
import {
  InventoryItem,
  LowStockAlert,
  LowStockRule,
  LowStockRuleInput,
} from '../types/inventory.types';

/**
 * BE-27 — Low-stock alert orchestration.
 *
 *   - `checkAndCreate(item, tx)` is called by `StockMovementService`
 *     after every quantity change. It evaluates the applicable rule
 *     for the (product, store), creates an alert when stock falls at
 *     or below the threshold, and resolves any open alert when stock
 *     rises back above. Returns the count of alerts CREATED in this
 *     call (resolutions don't increment the counter — callers use the
 *     counter to gate post-commit notifications).
 *
 *   - `setRule(...)` upserts a `low_stock_rules` row.
 *
 *   - `notifyForOpenItem` runs the BE-24 notification fan-out. It is
 *     intentionally separate from the in-tx check so we never block
 *     a stock movement on a flaky push gateway.
 *
 * Notifications use BE-24's `NotificationsService.sendTemplate` with
 * the `'generic'` template until a dedicated `low-stock-alert`
 * template lands in BE-24's `DEFAULT_TEMPLATES`. We flag this in the
 * BE-27 INTEGRATION CHECKLIST so the orchestrator can register the
 * proper template key and migrate at no breaking-change cost.
 */
@Injectable()
export class LowStockAlertService {
  constructor(
    private readonly itemsRepo: InventoryItemsRepository,
    private readonly alertsRepo: LowStockAlertsRepository,
    private readonly rulesRepo: LowStockRulesRepository,
    private readonly productsRepo: ProductsRepository,
    private readonly notifications: NotificationsService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Evaluates the applicable rule and updates the alert state.
   * Returns the number of alerts CREATED (0 or 1) in this call.
   */
  async checkAndCreate(item: InventoryItem, tx: Transaction): Promise<number> {
    const rule = await this.rulesRepo.findApplicableRule(item.productId, item.storeId);
    if (!rule || rule.enabled !== 1) {
      return 0;
    }

    const isLow = item.quantity <= rule.threshold;
    if (isLow) {
      const { alert, created } = await this.alertsRepo.createIfNotActive(
        {
          tenantId: item.tenantId,
          storeId: item.storeId,
          productId: item.productId,
          inventoryItemId: item.id,
          threshold: rule.threshold,
          currentQuantity: item.quantity,
        },
        tx,
      );
      if (created) {
        await this.itemsRepo.update(
          item.id,
          { isLowStock: 1, lowStockThreshold: rule.threshold },
          tx,
        );
        this.logger.info('inventory.low_stock.alert_created', {
          tenantId: item.tenantId,
          storeId: item.storeId,
          productId: item.productId,
          alertId: alert.id,
          quantity: item.quantity,
          threshold: rule.threshold,
        });
        return 1;
      }
      return 0;
    }

    // Stock is back above the threshold — resolve any open alerts.
    const resolved = await this.alertsRepo.resolveForItem(item.productId, item.storeId, tx);
    if (resolved > 0 || item.isLowStock === 1) {
      await this.itemsRepo.update(
        item.id,
        { isLowStock: 0, lowStockThreshold: rule.threshold },
        tx,
      );
    }
    return 0;
  }

  /* ─────────────────── Rule management ─────────────────── */

  async setRule(tenantId: string, userId: string, input: LowStockRuleInput): Promise<LowStockRule> {
    const enabled = input.enabled ?? true;
    const row = await this.rulesRepo.upsert({
      tenantId,
      storeId: input.storeId,
      productId: input.productId ?? null,
      category: input.category ?? null,
      threshold: input.threshold,
      enabled: enabled ? 1 : 0,
      notes: input.notes ?? null,
      createdBy: userId,
      updatedBy: userId,
    });
    return row;
  }

  async listRules(tenantId: string, storeId: string): Promise<LowStockRule[]> {
    return this.rulesRepo.listForStore(tenantId, storeId);
  }

  async deleteRule(tenantId: string, ruleId: string, userId: string): Promise<void> {
    const rule = await this.rulesRepo.findById(ruleId);
    if (!rule) return;
    if (rule.tenantId !== tenantId) return;
    await this.rulesRepo.softDelete(ruleId, userId);
  }

  /* ─────────────────── Alerts read ─────────────────── */

  async listActiveForStore(tenantId: string, storeId: string): Promise<LowStockAlert[]> {
    return this.alertsRepo.listActiveForStore(tenantId, storeId);
  }

  /* ─────────────────── Post-commit notifications ─────────────────── */

  /**
   * Fans out a low-stock notification for the open alert on the given
   * inventory item. Best-effort: failures are logged and never thrown.
   * Idempotency: alerts that already have `notifiedAt` set are
   * skipped.
   */
  async notifyForOpenItem(inventoryItemId: string, tenantId: string): Promise<void> {
    try {
      const item = await this.itemsRepo.findById(inventoryItemId);
      if (!item) return;
      const alert = await this.alertsRepo.findActiveForItem(item.productId, item.storeId);
      if (!alert || alert.notifiedAt) return;

      const product = await this.productsRepo.findById(item.productId);
      const productName = product?.name ?? `Product ${item.productId.slice(0, 8)}`;

      await this.notifications.sendTemplate(
        'generic',
        // The Mobile_App in-app inbox is the receipt for these. We
        // address them to "no specific user"; BE-24 routes generic
        // tenant-scope notifications to all tenant managers.
        [{ userId: 'tenant-managers' }],
        {
          subject: `Low stock: ${productName}`,
          body: `${productName} is at ${alert.currentQuantity} units, below threshold ${alert.threshold}.`,
          html: undefined,
        },
        { tenantId, channels: ['in-app', 'push'] },
      );
      await this.alertsRepo.markNotified(alert.id);
    } catch (err) {
      this.logger.warn('inventory.low_stock.notify_failed', {
        inventoryItemId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    }
  }
}
