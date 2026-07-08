import { InventoryBatchesRepository } from '../repositories/inventory-batches.repository';
import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { LowStockAlertsRepository } from '../repositories/low-stock-alerts.repository';
import { InventoryAggregatorService } from '../services/inventory-aggregator.service';

const TENANT = '00000000-0000-0000-0000-000000000001';
const STORE = '00000000-0000-0000-0000-000000000002';

const buildSvc = (
  opts: {
    aggregate?: { totalProducts: number; totalQuantity: number; lowStockCount: number };
    activeAlerts?: unknown[];
    expiringSoon?: unknown[];
    expired?: unknown[];
    items?: Array<{ quantity: number }>;
  } = {},
) => {
  const itemsRepo = {
    aggregateForStore: jest.fn(
      async () => opts.aggregate ?? { totalProducts: 0, totalQuantity: 0, lowStockCount: 0 },
    ),
    listForStore: jest.fn(async () => opts.items ?? []),
  } as unknown as InventoryItemsRepository;

  const batchesRepo = {
    findExpiringSoonForStore: jest.fn(async () => opts.expiringSoon ?? []),
    findExpiredForStore: jest.fn(async () => opts.expired ?? []),
  } as unknown as InventoryBatchesRepository;

  const alertsRepo = {
    listActiveForStore: jest.fn(async () => opts.activeAlerts ?? []),
  } as unknown as LowStockAlertsRepository;

  const svc = new InventoryAggregatorService(itemsRepo, batchesRepo, alertsRepo);
  return { svc, itemsRepo, batchesRepo, alertsRepo };
};

describe('InventoryAggregatorService.storeSummary', () => {
  it('returns zeros when nothing is in the store', async () => {
    const { svc } = buildSvc();
    const summary = await svc.storeSummary(TENANT, STORE);
    expect(summary).toMatchObject({
      storeId: STORE,
      totalProducts: 0,
      totalQuantity: 0,
      lowStockCount: 0,
      expiringSoonCount: 0,
      expiredCount: 0,
    });
  });

  it('forwards alert count, expiring-soon and expired counts', async () => {
    const { svc } = buildSvc({
      aggregate: { totalProducts: 25, totalQuantity: 1234, lowStockCount: 3 },
      activeAlerts: [{}, {}, {}],
      expiringSoon: [{}, {}],
      expired: [{}],
    });
    const summary = await svc.storeSummary(TENANT, STORE);
    expect(summary.totalProducts).toBe(25);
    expect(summary.totalQuantity).toBe(1234);
    expect(summary.lowStockCount).toBe(3);
    expect(summary.expiringSoonCount).toBe(2);
    expect(summary.expiredCount).toBe(1);
  });

  it('totalValue is null until cost-of-goods is wired', async () => {
    const { svc } = buildSvc();
    const summary = await svc.storeSummary(TENANT, STORE);
    expect(summary.totalValue).toBeNull();
  });
});

describe('InventoryAggregatorService.categoryBreakdown', () => {
  it('returns empty array when no items', async () => {
    const { svc } = buildSvc();
    const result = await svc.categoryBreakdown(TENANT, STORE);
    expect(result).toEqual([]);
  });

  it('rolls everything into uncategorized for now', async () => {
    const { svc } = buildSvc({
      items: [{ quantity: 5 }, { quantity: 12 }, { quantity: 3 }],
    });
    const result = await svc.categoryBreakdown(TENANT, STORE);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      category: 'uncategorized',
      productCount: 3,
      totalQuantity: 20,
    });
  });
});
