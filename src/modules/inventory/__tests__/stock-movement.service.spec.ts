import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';

import { InventoryBatchesRepository } from '../repositories/inventory-batches.repository';
import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { StockMovementsRepository } from '../repositories/stock-movements.repository';
import { LowStockAlertService } from '../services/low-stock-alert.service';
import { StockMovementService } from '../services/stock-movement.service';
import type {
  InventoryBatch,
  InventoryItem,
  StockMovement,
} from '../types/inventory.types';

const TENANT = '00000000-0000-0000-0000-000000000001';
const STORE = '00000000-0000-0000-0000-000000000002';
const PRODUCT = '00000000-0000-0000-0000-000000000003';
const USER = '00000000-0000-0000-0000-000000000004';

const dbStub = (): DbService =>
  ({
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  }) as unknown as DbService;

const baseItem = (over: Partial<InventoryItem> = {}): InventoryItem =>
  ({
    id: 'item-1',
    tenantId: TENANT,
    storeId: STORE,
    productId: PRODUCT,
    quantity: 0,
    reservedQuantity: 0,
    availableQuantity: 0,
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

const baseBatch = (over: Partial<InventoryBatch> = {}): InventoryBatch =>
  ({
    id: 'batch-1',
    inventoryItemId: 'item-1',
    tenantId: TENANT,
    storeId: STORE,
    productId: PRODUCT,
    batchNumber: null,
    quantity: 0,
    expiryDate: null,
    manufactureDate: null,
    receivedAt: new Date(),
    sourceType: null,
    sourceId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as InventoryBatch;

interface BuildOpts {
  existingItem?: InventoryItem | null;
  existingBatch?: InventoryBatch | null;
  fifoBatches?: InventoryBatch[];
  alertsCreated?: number;
}

const buildSvc = (opts: BuildOpts = {}) => {
  let currentItem = opts.existingItem ?? null;
  const itemUpdates: Array<Partial<InventoryItem>> = [];
  const batchUpdates: Array<{ id: string; data: Partial<InventoryBatch> }> = [];
  const movementsCreated: Array<Partial<StockMovement>> = [];

  const itemsRepo = {
    findByProductAndStore: jest.fn(async () => currentItem),
    create: jest.fn(async (data: Partial<InventoryItem>) => {
      currentItem = baseItem({ ...data, id: 'item-1' });
      return currentItem;
    }),
    update: jest.fn(async (id: string, data: Partial<InventoryItem>) => {
      itemUpdates.push(data);
      currentItem = currentItem
        ? ({ ...currentItem, ...data } as InventoryItem)
        : baseItem({ ...data, id });
      return currentItem;
    }),
    findById: jest.fn(async () => currentItem),
  } as unknown as InventoryItemsRepository;

  const batches: InventoryBatch[] = opts.fifoBatches
    ? [...opts.fifoBatches]
    : opts.existingBatch
      ? [opts.existingBatch]
      : [];

  const batchesRepo = {
    findByBatchNumber: jest.fn(
      async (_p: string, _s: string, bn: string) =>
        batches.find((b) => b.batchNumber === bn) ?? null,
    ),
    findFifoBatches: jest.fn(async () => batches.filter((b) => b.quantity > 0)),
    create: jest.fn(async (data: Partial<InventoryBatch>) => {
      const created = baseBatch({ ...data, id: `batch-${batches.length + 1}` });
      batches.push(created);
      return created;
    }),
    update: jest.fn(async (id: string, data: Partial<InventoryBatch>) => {
      batchUpdates.push({ id, data });
      const idx = batches.findIndex((b) => b.id === id);
      if (idx >= 0) batches[idx] = { ...batches[idx], ...data } as InventoryBatch;
      return batches[idx];
    }),
  } as unknown as InventoryBatchesRepository;

  const movementsRepo = {
    create: jest.fn(async (data: Partial<StockMovement>) => {
      const m = { ...data, id: `mov-${movementsCreated.length + 1}` } as StockMovement;
      movementsCreated.push(m);
      return m;
    }),
  } as unknown as StockMovementsRepository;

  const alertService = {
    checkAndCreate: jest.fn(async () => opts.alertsCreated ?? 0),
    notifyForOpenItem: jest.fn(async () => undefined),
  } as unknown as LowStockAlertService;

  const svc = new StockMovementService(
    dbStub(),
    itemsRepo,
    batchesRepo,
    movementsRepo,
    alertService,
  );

  return {
    svc,
    itemsRepo,
    batchesRepo,
    movementsRepo,
    alertService,
    movementsCreated,
    itemUpdates,
    batchUpdates,
    batches,
    getCurrentItem: () => currentItem,
  };
};

describe('StockMovementService.stockIn', () => {
  it('creates a new inventory item when none exists', async () => {
    const { svc, itemsRepo, getCurrentItem } = buildSvc();
    const result = await svc.stockIn(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 5,
      reason: 'manual_in',
    });
    expect(result.newQuantity).toBe(5);
    expect(itemsRepo.create).toHaveBeenCalled();
    expect(getCurrentItem()?.quantity).toBe(5);
  });

  it('increments quantity on existing item', async () => {
    const existing = baseItem({ quantity: 10, availableQuantity: 10, totalIn: 10 });
    const { svc, itemUpdates } = buildSvc({ existingItem: existing });
    const result = await svc.stockIn(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 3,
      reason: 'manual_in',
    });
    expect(result.newQuantity).toBe(13);
    expect(itemUpdates[0]).toMatchObject({ quantity: 13, totalIn: 13 });
  });

  it('records a positive movement with quantityBefore/After', async () => {
    const { svc, movementsCreated } = buildSvc({
      existingItem: baseItem({ quantity: 2, availableQuantity: 2, totalIn: 2 }),
    });
    await svc.stockIn(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 4,
      reason: 'manual_in',
    });
    expect(movementsCreated[0]).toMatchObject({
      type: 'in',
      quantity: 4,
      quantityBefore: 2,
      quantityAfter: 6,
    });
  });

  it('upserts a named batch when batchNumber is given', async () => {
    const existingBatch = baseBatch({ batchNumber: 'B-1', quantity: 5 });
    const { svc, batchUpdates } = buildSvc({
      existingItem: baseItem({ quantity: 5, availableQuantity: 5, totalIn: 5 }),
      existingBatch,
    });
    await svc.stockIn(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 3,
      reason: 'manual_in',
      batchNumber: 'B-1',
    });
    expect(batchUpdates).toHaveLength(1);
    expect(batchUpdates[0].data.quantity).toBe(8);
  });

  it('rejects non-positive quantity', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.stockIn(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        quantity: 0,
        reason: 'manual_in',
      }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('threads unit cost into total cost', async () => {
    const { svc, movementsCreated } = buildSvc();
    await svc.stockIn(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 5,
      reason: 'manual_in',
      unitCost: 3,
    });
    expect(movementsCreated[0]).toMatchObject({ unitCost: '3', totalCost: '15' });
  });

  it('returns alertsGenerated forwarded from alert service', async () => {
    const { svc } = buildSvc({ alertsCreated: 1 });
    const result = await svc.stockIn(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 5,
      reason: 'manual_in',
    });
    expect(result.alertsGenerated).toBe(1);
  });
});

describe('StockMovementService.stockOut', () => {
  it('throws when no inventory item exists', async () => {
    const { svc } = buildSvc({ existingItem: null });
    await expect(
      svc.stockOut(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        quantity: 1,
        reason: 'sale',
      }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('rejects with INSUFFICIENT_STOCK when available < requested', async () => {
    const { svc } = buildSvc({
      existingItem: baseItem({ quantity: 2, availableQuantity: 2 }),
    });
    await expect(
      svc.stockOut(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        quantity: 3,
        reason: 'sale',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_STOCK });
  });

  it('rejects cross-tenant access with NotFoundException (no info leak)', async () => {
    const { svc } = buildSvc({
      existingItem: baseItem({ tenantId: 'other-tenant', quantity: 10, availableQuantity: 10 }),
    });
    await expect(
      svc.stockOut(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        quantity: 1,
        reason: 'sale',
      }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('records a NEGATIVE quantity movement on stock-out', async () => {
    const { svc, movementsCreated } = buildSvc({
      existingItem: baseItem({ quantity: 10, availableQuantity: 10 }),
      fifoBatches: [baseBatch({ batchNumber: 'A', quantity: 10, expiryDate: new Date() })],
    });
    await svc.stockOut(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 3,
      reason: 'sale',
    });
    expect(movementsCreated[0]).toMatchObject({
      type: 'out',
      quantity: -3,
      quantityBefore: 10,
      quantityAfter: 7,
    });
  });

  it('deducts from a pinned batch when batchNumber is provided', async () => {
    const { svc, batchUpdates } = buildSvc({
      existingItem: baseItem({ quantity: 10, availableQuantity: 10 }),
      fifoBatches: [
        baseBatch({
          id: 'b-old',
          batchNumber: 'OLD',
          quantity: 5,
          expiryDate: new Date('2026-01-01'),
        }),
        baseBatch({
          id: 'b-new',
          batchNumber: 'NEW',
          quantity: 5,
          expiryDate: new Date('2027-01-01'),
        }),
      ],
    });
    await svc.stockOut(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 2,
      reason: 'sale',
      batchNumber: 'NEW',
    });
    expect(batchUpdates).toHaveLength(1);
    expect(batchUpdates[0]).toMatchObject({ id: 'b-new', data: { quantity: 3 } });
  });

  it('rejects pinned batch deduction when batch lacks stock', async () => {
    const { svc } = buildSvc({
      existingItem: baseItem({ quantity: 10, availableQuantity: 10 }),
      fifoBatches: [baseBatch({ batchNumber: 'A', quantity: 1 })],
    });
    await expect(
      svc.stockOut(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        quantity: 2,
        reason: 'sale',
        batchNumber: 'A',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_STOCK });
  });

  it('FIFO: deducts from oldest expiry first when no batch pinned', async () => {
    const oldB = baseBatch({
      id: 'b-old',
      batchNumber: 'OLD',
      quantity: 3,
      expiryDate: new Date('2026-01-01'),
    });
    const newB = baseBatch({
      id: 'b-new',
      batchNumber: 'NEW',
      quantity: 5,
      expiryDate: new Date('2027-01-01'),
    });
    const { svc, batchUpdates } = buildSvc({
      existingItem: baseItem({ quantity: 8, availableQuantity: 8 }),
      fifoBatches: [oldB, newB],
    });
    await svc.stockOut(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 5,
      reason: 'sale',
    });
    expect(batchUpdates).toHaveLength(2);
    expect(batchUpdates[0]).toMatchObject({ id: 'b-old', data: { quantity: 0 } });
    expect(batchUpdates[1]).toMatchObject({ id: 'b-new', data: { quantity: 3 } });
  });
});

describe('StockMovementService.adjust', () => {
  it('emits a positive delta when newQuantity > current', async () => {
    const { svc, movementsCreated } = buildSvc({
      existingItem: baseItem({ quantity: 5, availableQuantity: 5 }),
    });
    await svc.adjust(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      newQuantity: 8,
      reason: 'count_adjustment',
    });
    expect(movementsCreated[0]).toMatchObject({
      type: 'adjustment',
      quantity: 3,
      quantityBefore: 5,
      quantityAfter: 8,
    });
  });

  it('emits a negative delta when newQuantity < current', async () => {
    const { svc, movementsCreated } = buildSvc({
      existingItem: baseItem({ quantity: 8, availableQuantity: 8 }),
    });
    await svc.adjust(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      newQuantity: 3,
      reason: 'count_adjustment',
    });
    expect(movementsCreated[0]).toMatchObject({ quantity: -5, quantityAfter: 3 });
  });

  it('rejects when no inventory item exists', async () => {
    const { svc } = buildSvc({ existingItem: null });
    await expect(
      svc.adjust(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        newQuantity: 1,
        reason: 'count_adjustment',
      }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });
});

describe('StockMovementService — invariants (property-flavoured)', () => {
  it('N stock-in then N stock-out returns to initial quantity', async () => {
    const { svc, getCurrentItem } = buildSvc();
    const initial = 0;
    const cycles = 5;
    const each = 7;

    for (let i = 0; i < cycles; i++) {
      await svc.stockIn(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        quantity: each,
        reason: 'manual_in',
      });
    }
    expect(getCurrentItem()?.quantity).toBe(initial + cycles * each);

    for (let i = 0; i < cycles; i++) {
      await svc.stockOut(TENANT, USER, {
        productId: PRODUCT,
        storeId: STORE,
        quantity: each,
        reason: 'sale',
      });
    }
    expect(getCurrentItem()?.quantity).toBe(initial);
  });

  it('FIFO order is deterministic across multiple stock-outs', async () => {
    // 3 batches, 1 unit each, oldest first. 3 individual stock-outs of
    // 1 unit each should consume them in [old, mid, new] order.
    const old1 = baseBatch({
      id: 'b1',
      batchNumber: '1',
      quantity: 1,
      expiryDate: new Date('2026-01-01'),
    });
    const old2 = baseBatch({
      id: 'b2',
      batchNumber: '2',
      quantity: 1,
      expiryDate: new Date('2026-06-01'),
    });
    const old3 = baseBatch({
      id: 'b3',
      batchNumber: '3',
      quantity: 1,
      expiryDate: new Date('2027-01-01'),
    });
    const { svc, batchUpdates } = buildSvc({
      existingItem: baseItem({ quantity: 3, availableQuantity: 3 }),
      fifoBatches: [old1, old2, old3],
    });

    await svc.stockOut(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 1,
      reason: 'sale',
    });
    await svc.stockOut(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 1,
      reason: 'sale',
    });
    await svc.stockOut(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 1,
      reason: 'sale',
    });

    expect(batchUpdates[0]).toMatchObject({ id: 'b1', data: { quantity: 0 } });
    expect(batchUpdates[1]).toMatchObject({ id: 'b2', data: { quantity: 0 } });
    expect(batchUpdates[2]).toMatchObject({ id: 'b3', data: { quantity: 0 } });
  });
});
