import { DomainNotFoundException } from '@/common/errors/business.exception';
import type { DbService } from '@/db/db.service';

import type { InventoryBatchesRepository } from '../repositories/inventory-batches.repository';
import type { InventoryItemsRepository } from '../repositories/inventory-items.repository';
import type { StockMovementsRepository } from '../repositories/stock-movements.repository';
import type { LowStockAlertService } from './low-stock-alert.service';
import { StockMovementService } from './stock-movement.service';

/**
 * Cross-tenant write safety for the inventory write chokepoint.
 *
 * `InventoryItemsRepository.findByProductAndStore` is keyed on (product, store)
 * only — not tenant — so each write path must verify the resolved row belongs
 * to the caller's tenant before mutating it. Stock-out and adjust always did;
 * this proves stock-in now matches (and the others still hold).
 */
describe('StockMovementService — cross-tenant write guard', () => {
  const TENANT = 'tenant-a';
  const OTHER = 'tenant-b';

  function makeItem(tenantId: string) {
    return {
      id: 'item-1',
      tenantId,
      storeId: 'store-1',
      productId: 'prod-1',
      quantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
      totalIn: 10,
      totalOut: 0,
    };
  }

  function build(foundTenantId: string | null) {
    const existing = foundTenantId === null ? null : makeItem(foundTenantId);
    const itemsRepo = {
      findByProductAndStore: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue(makeItem(TENANT)),
      update: jest.fn().mockResolvedValue(makeItem(TENANT)),
    } as unknown as InventoryItemsRepository;
    const batchesRepo = {
      findByBatchNumber: jest.fn().mockResolvedValue(null),
      findFifoBatches: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'batch-1' }),
      update: jest.fn().mockResolvedValue({ id: 'batch-1' }),
    } as unknown as InventoryBatchesRepository;
    const movementsRepo = {
      create: jest.fn().mockResolvedValue({ id: 'mv-1' }),
    } as unknown as StockMovementsRepository;
    const alertService = {
      checkAndCreate: jest.fn().mockResolvedValue(0),
    } as unknown as LowStockAlertService;
    // Run the callback against a throwaway tx, ignoring isolation options.
    const db = {
      transaction: jest.fn(<T>(cb: (tx: unknown) => Promise<T>) => cb({})),
    } as unknown as DbService;

    const service = new StockMovementService(
      db,
      itemsRepo,
      batchesRepo,
      movementsRepo,
      alertService,
    );
    return { service, itemsRepo, movementsRepo };
  }

  it('stock-in refuses to write to a row owned by another tenant', async () => {
    const { service, itemsRepo, movementsRepo } = build(OTHER);
    await expect(
      service.stockIn(TENANT, 'user-1', {
        productId: 'prod-1',
        storeId: 'store-1',
        quantity: 5,
        reason: 'manual_in',
      }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
    expect(itemsRepo.update).not.toHaveBeenCalled();
    expect(itemsRepo.create).not.toHaveBeenCalled();
    expect(movementsRepo.create).not.toHaveBeenCalled();
  });

  it('stock-in updates an existing same-tenant row', async () => {
    const { service, itemsRepo, movementsRepo } = build(TENANT);
    const result = await service.stockIn(TENANT, 'user-1', {
      productId: 'prod-1',
      storeId: 'store-1',
      quantity: 5,
      reason: 'manual_in',
    });
    expect(itemsRepo.update).toHaveBeenCalledTimes(1);
    expect(movementsRepo.create).toHaveBeenCalledTimes(1);
    expect(result.newQuantity).toBe(15);
  });

  it('stock-in creates a new row when none exists for the tenant', async () => {
    const { service, itemsRepo } = build(null);
    await service.stockIn(TENANT, 'user-1', {
      productId: 'prod-1',
      storeId: 'store-1',
      quantity: 5,
      reason: 'manual_in',
    });
    expect(itemsRepo.create).toHaveBeenCalledTimes(1);
    expect(itemsRepo.update).not.toHaveBeenCalled();
  });

  it('stock-out refuses a row owned by another tenant', async () => {
    const { service, movementsRepo } = build(OTHER);
    await expect(
      service.stockOut(TENANT, 'user-1', {
        productId: 'prod-1',
        storeId: 'store-1',
        quantity: 1,
        reason: 'sale',
      }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
    expect(movementsRepo.create).not.toHaveBeenCalled();
  });

  it('adjust refuses a row owned by another tenant', async () => {
    const { service, movementsRepo } = build(OTHER);
    await expect(
      service.adjust(TENANT, 'user-1', {
        productId: 'prod-1',
        storeId: 'store-1',
        newQuantity: 3,
        reason: 'count_adjustment',
      }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
    expect(movementsRepo.create).not.toHaveBeenCalled();
  });
});
