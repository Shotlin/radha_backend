import { InventoryAccuracyMetricsQuery } from '../queries/inventory-accuracy-metrics.query';
import { StockMovementsRepository } from '../repositories/stock-movements.repository';
import type { StockMovement } from '../types/inventory.types';

const TENANT = '00000000-0000-0000-0000-000000000001';
const STORE = '00000000-0000-0000-0000-000000000002';

const m = (over: Partial<StockMovement> = {}): StockMovement =>
  ({
    id: 'm-1',
    tenantId: TENANT,
    storeId: STORE,
    productId: 'p-1',
    type: 'adjustment',
    reason: 'count_adjustment',
    quantity: 0,
    quantityBefore: 0,
    quantityAfter: 0,
    inventoryItemId: null,
    inventoryBatchId: null,
    batchNumber: null,
    sourceType: 'count',
    sourceId: null,
    unitCost: null,
    totalCost: null,
    userId: 'u-1',
    notes: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as StockMovement;

const buildQuery = (rows: StockMovement[]) => {
  const repo = {
    findCountAdjustmentsBetween: jest.fn(async () => rows),
  } as unknown as StockMovementsRepository;
  return { query: new InventoryAccuracyMetricsQuery(repo), repo };
};

describe('InventoryAccuracyMetricsQuery (BE-27 v2 ADDENDUM)', () => {
  it('returns 0 variance, 0 counts when window is empty', async () => {
    const { query } = buildQuery([]);
    const result = await query.forStore(TENANT, STORE, 30);
    expect(result).toEqual({ varianceRate: 0, countsPerformed: 0, windowDays: 30 });
  });

  it('T-v2.1: returns 0.0 variance when all counts equal system stock', async () => {
    const rows = [
      m({ quantityBefore: 10, quantity: 0, quantityAfter: 10 }),
      m({ quantityBefore: 5, quantity: 0, quantityAfter: 5 }),
      m({ quantityBefore: 100, quantity: 0, quantityAfter: 100 }),
    ];
    const { query } = buildQuery(rows);
    const result = await query.forStore(TENANT, STORE, 30);
    expect(result.varianceRate).toBe(0);
    expect(result.countsPerformed).toBe(3);
  });

  it('T-v2.2: variance is proportional to absolute counted-vs-system delta', async () => {
    const rows = [
      // before=10, delta=-2 → |delta|=2 against system=10
      m({ quantityBefore: 10, quantity: -2, quantityAfter: 8 }),
      // before=10, delta=+2 → |delta|=2 against system=10
      m({ quantityBefore: 10, quantity: 2, quantityAfter: 12 }),
    ];
    const { query } = buildQuery(rows);
    const result = await query.forStore(TENANT, STORE, 30);
    // sumAbs=4, sumSystem=20 → 0.2
    expect(result.varianceRate).toBeCloseTo(0.2, 6);
    expect(result.countsPerformed).toBe(2);
  });

  it('caps variance at 1.0 when delta exceeds system stock', async () => {
    const rows = [m({ quantityBefore: 1, quantity: -100, quantityAfter: 0 })];
    const { query } = buildQuery(rows);
    const result = await query.forStore(TENANT, STORE, 30);
    expect(result.varianceRate).toBe(1);
  });

  it('uses default 30-day window when not specified', async () => {
    const { query } = buildQuery([]);
    const result = await query.forStore(TENANT, STORE);
    expect(result.windowDays).toBe(30);
  });

  it('returns 1.0 when system stock is zero but variance exists', async () => {
    const rows = [m({ quantityBefore: 0, quantity: 5, quantityAfter: 5 })];
    const { query } = buildQuery(rows);
    const result = await query.forStore(TENANT, STORE);
    expect(result.varianceRate).toBe(1);
  });
});
