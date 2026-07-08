import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { GrnEventsRepository } from '../repositories/grn-events.repository';
import { GrnHeadersRepository } from '../repositories/grn-headers.repository';
import { GrnItemsRepository } from '../repositories/grn-items.repository';
import { GrnReversalService } from '../services/grn-reversal.service';
import type {
  Grn,
  GrnItem,
  IInventoryService,
  ISupplierPerformanceService,
} from '../types/grn.types';

const TENANT = 'tenant-1';
const USER = 'user-1';
const STORE = 'store-1';
const GRN_ID = 'grn-1';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const baseGrn = (over: Partial<Grn> = {}): Grn =>
  ({
    id: GRN_ID,
    tenantId: TENANT,
    storeId: STORE,
    grnNumber: 'GRN-XYZ-202606-0001',
    supplierId: 'supplier-1',
    invoiceNumber: 'INV-1',
    invoiceDate: new Date('2026-06-01'),
    poNumber: null,
    inwardDate: new Date('2026-06-05'),
    expectedDeliveryDate: null,
    orderDate: new Date('2026-06-01'),
    status: 'posted',
    totalAmount: '1000.00',
    totalItems: 1,
    totalQuantity: 5,
    minExpiryRemainingDays: 60,
    shortShelfLifeCount: 0,
    postedAt: new Date('2026-06-05'),
    postedBy: USER,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    reversedAt: null,
    reversedBy: null,
    reversalReason: null,
    notes: null,
    metadata: {},
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: USER,
    updatedBy: null,
    deletedBy: null,
    subtotal: null,
    taxAmount: null,
    ...over,
  }) as unknown as Grn;

const baseItem = (over: Partial<GrnItem> = {}): GrnItem =>
  ({
    id: 'item-1',
    grnId: GRN_ID,
    tenantId: TENANT,
    storeId: STORE,
    productId: 'product-1',
    ean: '8901234567890',
    productNameSnapshot: 'Test Product',
    quantity: 5,
    unit: 'pcs',
    batchNumber: 'B01',
    manufactureDate: new Date('2026-01-01'),
    expiryDate: new Date(Date.now() + 60 * 86_400_000),
    expiryRemainingDays: 60,
    unitPrice: '100.00',
    taxPercent: '5.00',
    totalPrice: '500.00',
    expiryRecordId: 'expiry-1',
    inventoryItemId: 'inv-1',
    stockMovementId: 'mov-1',
    notes: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as GrnItem;

const buildSvc = (opts: { grn?: Grn | null; items?: GrnItem[]; guardReturnsNull?: boolean }) => {
  const db: DbService = {
    transaction: jest.fn(async (cb) => cb({})),
  } as unknown as DbService;

  const headersRepo = {
    findByIdInTenant: jest.fn(async () => opts.grn ?? null),
    updateStatusGuarded: jest.fn(async (id: string, _froms: unknown, patch: Partial<Grn>) =>
      opts.guardReturnsNull
        ? null
        : ({
            ...(opts.grn ?? baseGrn()),
            ...patch,
            id,
          } as unknown as Grn),
    ),
  } as unknown as GrnHeadersRepository;

  const itemsRepo = {
    findByGrn: jest.fn(async () => opts.items ?? [baseItem()]),
  } as unknown as GrnItemsRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as GrnEventsRepository;

  const auditLog = {
    logAction: jest.fn(async () => undefined),
  } as unknown as AuditLogService;

  const inventory: IInventoryService = {
    applyInbound: jest.fn(),
    applyOutbound: jest.fn(async (req) => ({
      inventoryItemId: `inv-${req.sourceLineId}`,
      stockMovementId: `mov-rev-${req.sourceLineId}`,
      newQuantity: 0,
    })),
  };

  const supplierPerf: ISupplierPerformanceService = {
    updateMetrics: jest.fn(),
    reverseMetrics: jest.fn(async () => undefined),
  };

  const svc = new GrnReversalService(
    db,
    headersRepo,
    itemsRepo,
    eventsRepo,
    auditLog,
    buildLogger(),
    inventory,
    supplierPerf,
  );

  return {
    svc,
    headersRepo,
    itemsRepo,
    eventsRepo,
    inventory,
    supplierPerf,
    auditLog,
  };
};

describe('GrnReversalService.reverse', () => {
  it('throws when GRN not found', async () => {
    const { svc } = buildSvc({ grn: null });
    await expect(svc.reverse(GRN_ID, TENANT, USER, 'why')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects already-reversed GRN', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'reversed' }) });
    await expect(svc.reverse(GRN_ID, TENANT, USER, 'why')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('rejects non-posted GRN', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'draft' }) });
    await expect(svc.reverse(GRN_ID, TENANT, USER, 'why')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('emits one outbound movement per posted line item', async () => {
    const { svc, inventory } = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ id: 'a' }), baseItem({ id: 'b' })],
    });
    await svc.reverse(GRN_ID, TENANT, USER, 'wrong delivery');
    expect((inventory.applyOutbound as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('skips items that never resolved a productId', async () => {
    const { svc, inventory } = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ id: 'a' }), baseItem({ id: 'b', productId: null })],
    });
    const result = await svc.reverse(GRN_ID, TENANT, USER, 'wrong');
    expect((inventory.applyOutbound as jest.Mock).mock.calls).toHaveLength(1);
    expect(result.inventoryReverted).toBe(1);
  });

  it('flips status to reversed via the optimistic guard', async () => {
    const { svc, headersRepo } = buildSvc({ grn: baseGrn() });
    await svc.reverse(GRN_ID, TENANT, USER, 'damage');
    const call = (headersRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(call[1]).toEqual(['posted']);
    expect(call[2]).toMatchObject({
      status: 'reversed',
      reversedBy: USER,
      reversalReason: 'damage',
    });
  });

  it('appends a reversed event with reason', async () => {
    const { svc, eventsRepo } = buildSvc({ grn: baseGrn() });
    await svc.reverse(GRN_ID, TENANT, USER, 'damage in transit');
    const evt = (eventsRepo.create as jest.Mock).mock.calls[0][0];
    expect(evt.type).toBe('reversed');
    expect(evt.notes).toBe('damage in transit');
  });

  it('audit-logs with transition=reverse', async () => {
    const { svc, auditLog } = buildSvc({ grn: baseGrn() });
    await svc.reverse(GRN_ID, TENANT, USER, 'reason');
    const call = (auditLog.logAction as jest.Mock).mock.calls[0][0];
    expect(call.metadata.transition).toBe('reverse');
    expect(call.metadata.reason).toBe('reason');
  });

  it('throws when guard rejects (concurrent reverse)', async () => {
    const { svc } = buildSvc({
      grn: baseGrn(),
      guardReturnsNull: true,
    });
    await expect(svc.reverse(GRN_ID, TENANT, USER, 'why')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('signals supplier performance reversal post-commit', async () => {
    const { svc, supplierPerf } = buildSvc({ grn: baseGrn() });
    await svc.reverse(GRN_ID, TENANT, USER, 'reason');
    await new Promise((r) => setImmediate(r));
    expect(supplierPerf.reverseMetrics as jest.Mock).toHaveBeenCalledWith('supplier-1', GRN_ID);
  });
});
