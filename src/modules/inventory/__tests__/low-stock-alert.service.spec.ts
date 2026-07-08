import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { ProductsRepository } from '@/modules/products/products.repository';

import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { LowStockAlertsRepository } from '../repositories/low-stock-alerts.repository';
import { LowStockRulesRepository } from '../repositories/low-stock-rules.repository';
import { LowStockAlertService } from '../services/low-stock-alert.service';
import type { InventoryItem, LowStockAlert, LowStockRule } from '../types/inventory.types';

const TENANT = '00000000-0000-0000-0000-000000000001';
const STORE = '00000000-0000-0000-0000-000000000002';
const PRODUCT = '00000000-0000-0000-0000-000000000003';
const USER = '00000000-0000-0000-0000-000000000004';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const baseItem = (over: Partial<InventoryItem> = {}): InventoryItem =>
  ({
    id: 'item-1',
    tenantId: TENANT,
    storeId: STORE,
    productId: PRODUCT,
    quantity: 5,
    reservedQuantity: 0,
    availableQuantity: 5,
    lowStockThreshold: null,
    isLowStock: 0,
    lastMovementAt: null,
    lastInAt: null,
    lastOutAt: null,
    totalIn: 0,
    totalOut: 0,
    averageUnitCost: null,
    metadata: {},
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as unknown as InventoryItem;

const baseRule = (over: Partial<LowStockRule> = {}): LowStockRule =>
  ({
    id: 'rule-1',
    tenantId: TENANT,
    storeId: STORE,
    productId: PRODUCT,
    category: null,
    threshold: 10,
    enabled: 1,
    notes: null,
    metadata: {},
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as unknown as LowStockRule;

interface BuildOpts {
  rule?: LowStockRule | null;
  existingAlert?: LowStockAlert | null;
  resolveCount?: number;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const itemsRepo = {
    update: jest.fn(async (id: string, data: Partial<InventoryItem>) =>
      ({ id, ...data }) as InventoryItem,
    ),
    findById: jest.fn(async () => null),
  } as unknown as InventoryItemsRepository;

  const alertsRepo = {
    findActiveForItem: jest.fn(async () => opts.existingAlert ?? null),
    listActiveForStore: jest.fn(async () => []),
    createIfNotActive: jest.fn(async () =>
      opts.existingAlert
        ? { alert: opts.existingAlert, created: false }
        : {
            alert: { id: 'alert-1' } as unknown as LowStockAlert,
            created: true,
          },
    ),
    create: jest.fn(),
    resolveForItem: jest.fn(async () => opts.resolveCount ?? 0),
    markNotified: jest.fn(async () => undefined),
  } as unknown as LowStockAlertsRepository;

  const rulesRepo = {
    findApplicableRule: jest.fn(async () => opts.rule ?? null),
    findById: jest.fn(async () => opts.rule ?? null),
    listForStore: jest.fn(async () => []),
    upsert: jest.fn(async (data: Partial<LowStockRule>) => baseRule(data)),
    softDelete: jest.fn(async () => undefined),
  } as unknown as LowStockRulesRepository;

  const productsRepo = {
    findById: jest.fn(async () => ({ id: PRODUCT, name: 'Test Product' })),
  } as unknown as ProductsRepository;

  const notifications = {
    sendTemplate: jest.fn(async () => [{ notificationId: 'n-1' }]),
  } as unknown as NotificationsService;

  const svc = new LowStockAlertService(
    itemsRepo,
    alertsRepo,
    rulesRepo,
    productsRepo,
    notifications,
    buildLogger(),
  );

  return { svc, itemsRepo, alertsRepo, rulesRepo, productsRepo, notifications };
};

describe('LowStockAlertService.checkAndCreate', () => {
  it('returns 0 when no rule applies', async () => {
    const { svc, alertsRepo } = buildSvc({ rule: null });
    const created = await svc.checkAndCreate(baseItem({ quantity: 1 }), {} as never);
    expect(created).toBe(0);
    expect(alertsRepo.createIfNotActive).not.toHaveBeenCalled();
  });

  it('returns 0 when rule is disabled', async () => {
    const { svc, alertsRepo } = buildSvc({ rule: baseRule({ enabled: 0 }) });
    const created = await svc.checkAndCreate(baseItem({ quantity: 0 }), {} as never);
    expect(created).toBe(0);
    expect(alertsRepo.createIfNotActive).not.toHaveBeenCalled();
  });

  it('creates a new alert when stock at or below threshold', async () => {
    const { svc, alertsRepo, itemsRepo } = buildSvc({ rule: baseRule({ threshold: 10 }) });
    const created = await svc.checkAndCreate(baseItem({ quantity: 5 }), {} as never);
    expect(created).toBe(1);
    expect(alertsRepo.createIfNotActive).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 10, currentQuantity: 5 }),
      expect.anything(),
    );
    expect(itemsRepo.update).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ isLowStock: 1, lowStockThreshold: 10 }),
      expect.anything(),
    );
  });

  it('returns 0 (no new alert) when an active alert already exists', async () => {
    const existing = { id: 'alert-existing' } as unknown as LowStockAlert;
    const { svc } = buildSvc({ rule: baseRule({ threshold: 10 }), existingAlert: existing });
    const created = await svc.checkAndCreate(baseItem({ quantity: 5 }), {} as never);
    expect(created).toBe(0);
  });

  it('resolves open alerts when stock rises above threshold', async () => {
    const { svc, alertsRepo, itemsRepo } = buildSvc({
      rule: baseRule({ threshold: 10 }),
      resolveCount: 1,
    });
    const created = await svc.checkAndCreate(
      baseItem({ quantity: 50, isLowStock: 1 }),
      {} as never,
    );
    expect(created).toBe(0);
    expect(alertsRepo.resolveForItem).toHaveBeenCalledWith(PRODUCT, STORE, expect.anything());
    expect(itemsRepo.update).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ isLowStock: 0 }),
      expect.anything(),
    );
  });

  it('exact threshold counts as low stock (boundary at <=)', async () => {
    const { svc } = buildSvc({ rule: baseRule({ threshold: 5 }) });
    const created = await svc.checkAndCreate(baseItem({ quantity: 5 }), {} as never);
    expect(created).toBe(1);
  });
});

describe('LowStockAlertService rule management', () => {
  it('upserts a rule via setRule', async () => {
    const { svc, rulesRepo } = buildSvc();
    const rule = await svc.setRule(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      threshold: 7,
    });
    expect(rule.threshold).toBe(7);
    expect(rulesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        storeId: STORE,
        productId: PRODUCT,
        threshold: 7,
        enabled: 1,
      }),
    );
  });

  it('supports category-level rules', async () => {
    const { svc, rulesRepo } = buildSvc();
    await svc.setRule(TENANT, USER, {
      category: 'beverages',
      storeId: STORE,
      threshold: 12,
    });
    expect(rulesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'beverages', productId: null }),
    );
  });

  it('soft-deletes a rule when tenant matches', async () => {
    const rule = baseRule();
    const { svc, rulesRepo } = buildSvc({ rule });
    await svc.deleteRule(TENANT, rule.id, USER);
    expect(rulesRepo.softDelete).toHaveBeenCalledWith(rule.id, USER);
  });

  it('does not delete when tenant mismatches', async () => {
    const rule = baseRule({ tenantId: 'other' });
    const { svc, rulesRepo } = buildSvc({ rule });
    await svc.deleteRule(TENANT, rule.id, USER);
    expect(rulesRepo.softDelete).not.toHaveBeenCalled();
  });
});

describe('LowStockAlertService notifications', () => {
  it('skips notification when no item is found', async () => {
    const { svc, notifications } = buildSvc();
    await svc.notifyForOpenItem('missing-id', TENANT);
    expect(notifications.sendTemplate).not.toHaveBeenCalled();
  });

  it('skips notification when alert already notified', async () => {
    const item = baseItem();
    const alert = { id: 'alert-1', notifiedAt: new Date() } as unknown as LowStockAlert;
    const { svc, notifications, itemsRepo, alertsRepo } = buildSvc({ existingAlert: alert });
    (itemsRepo.findById as jest.Mock).mockResolvedValue(item);
    (alertsRepo.findActiveForItem as jest.Mock).mockResolvedValue(alert);
    await svc.notifyForOpenItem(item.id, TENANT);
    expect(notifications.sendTemplate).not.toHaveBeenCalled();
  });

  it('sends notification + marks alert as notified for open un-notified alert', async () => {
    const item = baseItem();
    const alert = {
      id: 'alert-1',
      notifiedAt: null,
      currentQuantity: 2,
      threshold: 10,
    } as unknown as LowStockAlert;
    const { svc, notifications, itemsRepo, alertsRepo } = buildSvc({ existingAlert: alert });
    (itemsRepo.findById as jest.Mock).mockResolvedValue(item);
    (alertsRepo.findActiveForItem as jest.Mock).mockResolvedValue(alert);
    await svc.notifyForOpenItem(item.id, TENANT);
    expect(notifications.sendTemplate).toHaveBeenCalledWith(
      'generic',
      expect.any(Array),
      expect.objectContaining({ subject: expect.stringContaining('Low stock') }),
      expect.objectContaining({ tenantId: TENANT }),
    );
    expect(alertsRepo.markNotified).toHaveBeenCalledWith(alert.id);
  });

  it('swallows notification errors (best-effort)', async () => {
    const item = baseItem();
    const alert = { id: 'alert-1', notifiedAt: null } as unknown as LowStockAlert;
    const { svc, notifications, itemsRepo, alertsRepo } = buildSvc({ existingAlert: alert });
    (itemsRepo.findById as jest.Mock).mockResolvedValue(item);
    (alertsRepo.findActiveForItem as jest.Mock).mockResolvedValue(alert);
    (notifications.sendTemplate as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(svc.notifyForOpenItem(item.id, TENANT)).resolves.toBeUndefined();
  });
});
