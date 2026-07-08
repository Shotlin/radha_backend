import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { StockCountLinesRepository } from '../repositories/stock-count-lines.repository';
import { StockCountsRepository } from '../repositories/stock-counts.repository';
import { StockCountService } from '../services/stock-count.service';
import { StockMovementService } from '../services/stock-movement.service';
import type {
  InventoryItem,
  StockCount,
  StockCountLine,
  StockMovement,
} from '../types/inventory.types';

const TENANT = '00000000-0000-0000-0000-000000000001';
const STORE = '00000000-0000-0000-0000-000000000002';
const PRODUCT = '00000000-0000-0000-0000-000000000003';
const USER = '00000000-0000-0000-0000-000000000004';
const COUNT = '00000000-0000-0000-0000-000000000099';

const dbStub = (): DbService =>
  ({
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  }) as unknown as DbService;

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildAudit = (): AuditLogService =>
  ({
    logAction: jest.fn(async () => undefined),
  }) as unknown as AuditLogService;

const baseCount = (over: Partial<StockCount> = {}): StockCount =>
  ({
    id: COUNT,
    tenantId: TENANT,
    storeId: STORE,
    status: 'in_progress',
    startedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
    notes: null,
    totalProducts: 0,
    variances: 0,
    totalVarianceQuantity: 0,
    adjustmentsCreated: 0,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: USER,
    updatedBy: USER,
    deletedBy: null,
    ...over,
  }) as unknown as StockCount;

const baseLine = (over: Partial<StockCountLine> = {}): StockCountLine =>
  ({
    id: 'line-1',
    stockCountId: COUNT,
    tenantId: TENANT,
    storeId: STORE,
    productId: PRODUCT,
    systemQuantity: 0,
    countedQuantity: 0,
    variance: 0,
    notes: null,
    adjustmentMovementId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as StockCountLine;

interface BuildOpts {
  count?: StockCount | null;
  lines?: StockCountLine[];
  guardReturnsNull?: boolean;
  inventoryItem?: InventoryItem | null;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const countsRepo = {
    findByIdInTenant: jest.fn(async () => opts.count ?? null),
    create: jest.fn(async (data: Partial<StockCount>) => baseCount({ ...data, id: COUNT })),
    listForStore: jest.fn(async () => []),
    updateStatusGuarded: jest.fn(async (id: string, _from: unknown, patch: Partial<StockCount>) =>
      opts.guardReturnsNull ? null : baseCount({ ...(opts.count ?? {}), ...patch, id }),
    ),
  } as unknown as StockCountsRepository;

  const linesRepo = {
    findByCount: jest.fn(async () => opts.lines ?? []),
    upsertForProduct: jest.fn(async (_c: string, _p: string, ins: Partial<StockCountLine>) =>
      baseLine(ins),
    ),
    update: jest.fn(async (id: string, patch: Partial<StockCountLine>) =>
      baseLine({ id, ...patch }),
    ),
  } as unknown as StockCountLinesRepository;

  const itemsRepo = {
    findByProductAndStore: jest.fn(async () => opts.inventoryItem ?? null),
  } as unknown as InventoryItemsRepository;

  const movementService = {
    applyAdjustInTx: jest.fn(async () => ({
      movement: { id: 'mov-1' } as StockMovement,
      inventoryItem: { id: 'item-1' } as InventoryItem,
      newQuantity: 0,
      alertsGenerated: 0,
    })),
  } as unknown as StockMovementService;

  const svc = new StockCountService(
    dbStub(),
    countsRepo,
    linesRepo,
    itemsRepo,
    movementService,
    buildAudit(),
    buildLogger(),
  );

  return { svc, countsRepo, linesRepo, itemsRepo, movementService };
};

describe('StockCountService.start', () => {
  it('creates an in_progress count with provided storeId', async () => {
    const { svc, countsRepo } = buildSvc();
    const result = await svc.start(TENANT, USER, { storeId: STORE });
    expect(result.status).toBe('in_progress');
    expect(countsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, storeId: STORE, status: 'in_progress' }),
      expect.anything(),
    );
  });
});

describe('StockCountService.recordLine', () => {
  it('throws when count is missing', async () => {
    const { svc } = buildSvc({ count: null });
    await expect(
      svc.recordLine(TENANT, COUNT, USER, { productId: PRODUCT, countedQuantity: 5 }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('rejects when count is no longer in_progress', async () => {
    const { svc } = buildSvc({ count: baseCount({ status: 'completed' }) });
    await expect(
      svc.recordLine(TENANT, COUNT, USER, { productId: PRODUCT, countedQuantity: 5 }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('records variance = counted - system when item exists', async () => {
    const { svc, linesRepo } = buildSvc({
      count: baseCount(),
      inventoryItem: { quantity: 8 } as unknown as InventoryItem,
    });
    await svc.recordLine(TENANT, COUNT, USER, { productId: PRODUCT, countedQuantity: 5 });
    expect(linesRepo.upsertForProduct).toHaveBeenCalledWith(
      COUNT,
      PRODUCT,
      expect.objectContaining({ systemQuantity: 8, countedQuantity: 5, variance: -3 }),
      expect.objectContaining({ systemQuantity: 8, countedQuantity: 5, variance: -3 }),
      expect.anything(),
    );
  });

  it('uses systemQuantity=0 when no inventory_item exists yet', async () => {
    const { svc, linesRepo } = buildSvc({ count: baseCount(), inventoryItem: null });
    await svc.recordLine(TENANT, COUNT, USER, { productId: PRODUCT, countedQuantity: 4 });
    expect(linesRepo.upsertForProduct).toHaveBeenCalledWith(
      COUNT,
      PRODUCT,
      expect.objectContaining({ systemQuantity: 0, countedQuantity: 4, variance: 4 }),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('StockCountService.complete', () => {
  it('throws when count is missing', async () => {
    const { svc } = buildSvc({ count: null });
    await expect(svc.complete(TENANT, COUNT, USER)).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects when already completed', async () => {
    const { svc } = buildSvc({ count: baseCount({ status: 'completed' }) });
    await expect(svc.complete(TENANT, COUNT, USER)).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects when cancelled', async () => {
    const { svc } = buildSvc({ count: baseCount({ status: 'cancelled' }) });
    await expect(svc.complete(TENANT, COUNT, USER)).rejects.toBeInstanceOf(BusinessException);
  });

  it('emits one adjustment per non-zero variance line', async () => {
    const lines = [
      baseLine({ id: 'L1', productId: 'p1', countedQuantity: 5, systemQuantity: 8, variance: -3 }),
      baseLine({ id: 'L2', productId: 'p2', countedQuantity: 7, systemQuantity: 7, variance: 0 }),
      baseLine({ id: 'L3', productId: 'p3', countedQuantity: 10, systemQuantity: 6, variance: 4 }),
    ];
    const { svc, movementService } = buildSvc({ count: baseCount(), lines });
    const result = await svc.complete(TENANT, COUNT, USER);
    expect(result.totalProducts).toBe(3);
    expect(result.variances).toBe(2);
    expect(result.totalVarianceQuantity).toBe(7); // |-3| + |+4|
    expect(result.adjustmentsCreated).toBe(2);
    expect(movementService.applyAdjustInTx).toHaveBeenCalledTimes(2);
  });

  it('throws CONCURRENT_MODIFICATION when guard returns null', async () => {
    const { svc } = buildSvc({
      count: baseCount(),
      lines: [baseLine({ countedQuantity: 5, systemQuantity: 0, variance: 5 })],
      guardReturnsNull: true,
    });
    await expect(svc.complete(TENANT, COUNT, USER)).rejects.toMatchObject({
      code: ErrorCode.CONCURRENT_MODIFICATION,
    });
  });
});

describe('StockCountService.cancel', () => {
  it('throws when count is missing', async () => {
    const { svc } = buildSvc({ count: null });
    await expect(svc.cancel(TENANT, COUNT, USER, 'reason')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects when count is not in_progress', async () => {
    const { svc } = buildSvc({ count: baseCount({ status: 'completed' }) });
    await expect(svc.cancel(TENANT, COUNT, USER, 'reason')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('flips status to cancelled with reason', async () => {
    const { svc, countsRepo } = buildSvc({ count: baseCount() });
    await svc.cancel(TENANT, COUNT, USER, 'shop closed');
    expect(countsRepo.updateStatusGuarded).toHaveBeenCalledWith(
      COUNT,
      ['in_progress'],
      expect.objectContaining({ status: 'cancelled', notes: 'shop closed' }),
      expect.anything(),
    );
  });
});
