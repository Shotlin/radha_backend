import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { InventoryService } from '../inventory.service';
import { InventoryBatchesRepository } from '../repositories/inventory-batches.repository';
import { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import { StockMovementsRepository } from '../repositories/stock-movements.repository';
import { InventoryAggregatorService } from '../services/inventory-aggregator.service';
import { LowStockAlertService } from '../services/low-stock-alert.service';
import { StockCountService } from '../services/stock-count.service';
import { StockMovementService } from '../services/stock-movement.service';
import type {
  InventoryBatch,
  InventoryItem,
  StockMovement,
  StockMovementResult,
} from '../types/inventory.types';

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

const buildAudit = (): AuditLogService =>
  ({
    logAction: jest.fn(async () => undefined),
  }) as unknown as AuditLogService;

const baseItem = (over: Partial<InventoryItem> = {}): InventoryItem =>
  ({
    id: 'item-1',
    tenantId: TENANT,
    storeId: STORE,
    productId: PRODUCT,
    quantity: 10,
    reservedQuantity: 0,
    availableQuantity: 10,
    lowStockThreshold: null,
    isLowStock: 0,
    lastMovementAt: null,
    lastInAt: null,
    lastOutAt: null,
    totalIn: 10,
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

const baseResult = (over: Partial<StockMovementResult> = {}): StockMovementResult => ({
  movement: { id: 'mov-1' } as StockMovement,
  inventoryItem: baseItem(),
  newQuantity: 10,
  alertsGenerated: 0,
  ...over,
});

const buildSvc = () => {
  const itemsRepo = {
    findByProductAndStore: jest.fn(async () => baseItem()),
    findById: jest.fn(async () => baseItem()),
    findByIdInTenant: jest.fn(async () => baseItem()),
    findPaginatedScoped: jest.fn(async () => ({ data: [], nextCursor: null, hasMore: false })),
  } as unknown as InventoryItemsRepository;

  const batchesRepo = {
    findByInventoryItem: jest.fn(async () => [] as InventoryBatch[]),
  } as unknown as InventoryBatchesRepository;

  const movementsRepo = {
    findPaginatedScoped: jest.fn(async () => ({ data: [], nextCursor: null, hasMore: false })),
  } as unknown as StockMovementsRepository;

  const movementService = {
    stockIn: jest.fn(async () => baseResult({ alertsGenerated: 0 })),
    stockOut: jest.fn(async () => baseResult({ newQuantity: 5, alertsGenerated: 1 })),
    adjust: jest.fn(async () => baseResult({ newQuantity: 7 })),
  } as unknown as StockMovementService;

  const alertService = {
    listActiveForStore: jest.fn(async () => []),
    listRules: jest.fn(async () => []),
    setRule: jest.fn(async () => ({ id: 'rule-1' })),
    deleteRule: jest.fn(async () => undefined),
    notifyForOpenItem: jest.fn(async () => undefined),
  } as unknown as LowStockAlertService;

  const countService = {
    start: jest.fn(),
    recordLine: jest.fn(),
    listLines: jest.fn(),
    complete: jest.fn(),
    cancel: jest.fn(),
    findById: jest.fn(),
    listForStore: jest.fn(),
  } as unknown as StockCountService;

  const aggregator = {
    storeSummary: jest.fn(async () => ({})),
    categoryBreakdown: jest.fn(async () => []),
  } as unknown as InventoryAggregatorService;

  const audit = buildAudit();
  const logger = buildLogger();

  const svc = new InventoryService(
    itemsRepo,
    batchesRepo,
    movementsRepo,
    movementService,
    alertService,
    countService,
    aggregator,
    audit,
    logger,
  );

  return {
    svc,
    itemsRepo,
    batchesRepo,
    movementsRepo,
    movementService,
    alertService,
    countService,
    aggregator,
    audit,
  };
};

describe('InventoryService.stockIn / stockOut / adjust audit logging', () => {
  it('audit-logs stock-in', async () => {
    const { svc, audit } = buildSvc();
    await svc.stockIn(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 5,
      reason: 'manual_in',
    });
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CREATE',
        resourceType: 'StockMovement',
        metadata: expect.objectContaining({ type: 'in' }),
      }),
    );
  });

  it('audit-logs stock-out and triggers post-commit notification when alert opened', async () => {
    const { svc, audit, alertService } = buildSvc();
    await svc.stockOut(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      quantity: 5,
      reason: 'sale',
    });
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CREATE',
        resourceType: 'StockMovement',
        metadata: expect.objectContaining({ type: 'out' }),
      }),
    );
    // Best-effort post-commit fan-out — assert it was attempted.
    expect(alertService.notifyForOpenItem).toHaveBeenCalled();
  });

  it('audit-logs adjust with type=adjustment', async () => {
    const { svc, audit } = buildSvc();
    await svc.adjust(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      newQuantity: 7,
      reason: 'count_adjustment',
    });
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'InventoryItem',
        metadata: expect.objectContaining({ type: 'adjustment' }),
      }),
    );
  });
});

describe('InventoryService — tenant-scoped reads', () => {
  it('getCurrentStock returns null for cross-tenant items', async () => {
    const { svc, itemsRepo } = buildSvc();
    (itemsRepo.findByProductAndStore as jest.Mock).mockResolvedValue(
      baseItem({ tenantId: 'other' }),
    );
    const result = await svc.getCurrentStock(TENANT, PRODUCT, STORE);
    expect(result).toBeNull();
  });

  it('getCurrentStock returns null when no item exists', async () => {
    const { svc, itemsRepo } = buildSvc();
    (itemsRepo.findByProductAndStore as jest.Mock).mockResolvedValue(null);
    const result = await svc.getCurrentStock(TENANT, PRODUCT, STORE);
    expect(result).toBeNull();
  });

  it('getStockByBatch returns [] on tenant mismatch', async () => {
    const { svc, itemsRepo, batchesRepo } = buildSvc();
    (itemsRepo.findByProductAndStore as jest.Mock).mockResolvedValue(
      baseItem({ tenantId: 'other' }),
    );
    const result = await svc.getStockByBatch(TENANT, PRODUCT, STORE);
    expect(result).toEqual([]);
    expect(batchesRepo.findByInventoryItem).not.toHaveBeenCalled();
  });
});

describe('InventoryService — GRN integration contract', () => {
  it('applyInbound delegates to stockIn with reason grn_post', async () => {
    const { svc, movementService } = buildSvc();
    const result = await svc.applyInbound({
      tenantId: TENANT,
      storeId: STORE,
      productId: PRODUCT,
      quantity: 4,
      source: 'grn',
      sourceId: 'grn-1',
      sourceLineId: 'line-1',
      actorId: USER,
    });
    expect(movementService.stockIn).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({
        reason: 'grn_post',
        sourceType: 'grn',
        sourceId: 'grn-1',
      }),
    );
    expect(result).toMatchObject({
      inventoryItemId: 'item-1',
      stockMovementId: 'mov-1',
    });
  });

  it('applyOutbound delegates to stockOut with reason grn_reversal', async () => {
    const { svc, movementService } = buildSvc();
    await svc.applyOutbound({
      tenantId: TENANT,
      storeId: STORE,
      productId: PRODUCT,
      quantity: 2,
      source: 'grn_reversal',
      sourceId: 'grn-1',
      sourceLineId: 'line-1',
      actorId: USER,
    });
    expect(movementService.stockOut).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({ reason: 'grn_reversal', sourceType: 'grn' }),
    );
  });
});

describe('InventoryService — low stock rule passthrough', () => {
  it('setLowStockRule audit-logs the change', async () => {
    const { svc, audit } = buildSvc();
    await svc.setLowStockRule(TENANT, USER, {
      productId: PRODUCT,
      storeId: STORE,
      threshold: 5,
    });
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'LowStockRule', action: 'UPDATE' }),
    );
  });
});
