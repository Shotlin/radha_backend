import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { ExpiryService } from '@/modules/expiry/expiry.service';
import { ProductsRepository } from '@/modules/products/products.repository';
import { AuditLogService } from '@/observability/audit-log.service';

import { GrnEventsRepository } from '../repositories/grn-events.repository';
import { GrnHeadersRepository } from '../repositories/grn-headers.repository';
import { GrnItemsRepository } from '../repositories/grn-items.repository';
import { GrnPostingService } from '../services/grn-posting.service';
import { GrnValidationService } from '../services/grn-validation.service';
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
    status: 'draft',
    subtotal: null,
    taxAmount: null,
    totalAmount: '1000.00',
    totalItems: 1,
    totalQuantity: 5,
    minExpiryRemainingDays: null,
    shortShelfLifeCount: 0,
    postedAt: null,
    postedBy: null,
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
    expiryRecordId: null,
    inventoryItemId: null,
    stockMovementId: null,
    notes: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as GrnItem;

interface BuildOpts {
  grn?: Grn | null;
  items?: GrnItem[];
  validation?: { valid: boolean; errors: unknown[]; warnings: unknown[] };
  guardReturnsNull?: boolean;
  inventoryThrows?: boolean;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const txCalls: number[] = [];
  const txStub = (cb: (tx: unknown) => Promise<unknown>) => cb({});

  const db: DbService = {
    transaction: jest.fn(async (cb, opts2) => {
      txCalls.push(opts2?.isolationLevel === 'serializable' ? 1 : 0);
      return txStub(cb as (tx: unknown) => Promise<unknown>);
    }),
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
    findByGrn: jest.fn(async () => opts.items ?? []),
    update: jest.fn(async () => undefined),
  } as unknown as GrnItemsRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as GrnEventsRepository;

  const validator = {
    validate: jest.fn(async () => opts.validation ?? { valid: true, errors: [], warnings: [] }),
  } as unknown as GrnValidationService;

  const productsRepo = {
    findVisibleByEan: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: 'auto-product' })),
  } as unknown as ProductsRepository;

  const expiryService = {
    createRecord: jest.fn(async () => ({
      id: 'expiry-1',
      daysRemaining: 60,
    })),
  } as unknown as ExpiryService;

  const auditLog = {
    logAction: jest.fn(async () => undefined),
  } as unknown as AuditLogService;

  const inventory: IInventoryService = {
    applyInbound: jest.fn(async (req) =>
      opts.inventoryThrows
        ? Promise.reject(new Error('inventory blew up'))
        : {
            inventoryItemId: `inv-${req.sourceLineId}`,
            stockMovementId: `mov-${req.sourceLineId}`,
            newQuantity: req.quantity,
          },
    ),
    applyOutbound: jest.fn(),
  };
  const supplierPerf: ISupplierPerformanceService = {
    updateMetrics: jest.fn(async () => undefined),
    reverseMetrics: jest.fn(async () => undefined),
  };

  const svc = new GrnPostingService(
    db,
    headersRepo,
    itemsRepo,
    eventsRepo,
    validator,
    productsRepo,
    expiryService,
    auditLog,
    buildLogger(),
    inventory,
    supplierPerf,
  );

  return {
    svc,
    db,
    headersRepo,
    itemsRepo,
    eventsRepo,
    validator,
    productsRepo,
    expiryService,
    auditLog,
    inventory,
    supplierPerf,
    txCalls,
  };
};

describe('GrnPostingService.post — preflight', () => {
  it('throws DomainNotFoundException when GRN not found', async () => {
    const { svc } = buildSvc({ grn: null });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('rejects already-posted GRN with GRN_ALREADY_POSTED', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'posted' }) });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toMatchObject({
      code: ErrorCode.GRN_ALREADY_POSTED,
    });
  });

  it('rejects cancelled GRN', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'cancelled' }) });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects reversed GRN', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'reversed' }) });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects when validation fails', async () => {
    const { svc } = buildSvc({
      grn: baseGrn(),
      validation: {
        valid: false,
        errors: [{ field: 'items', message: 'no items' }],
        warnings: [],
      },
    });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('rejects when no items in transaction', async () => {
    const { svc } = buildSvc({ grn: baseGrn(), items: [] });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toBeInstanceOf(BusinessException);
  });
});

describe('GrnPostingService.post — atomic transaction', () => {
  it('opens a serializable transaction', async () => {
    const { svc, txCalls } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
    });
    await svc.post(GRN_ID, TENANT, USER);
    expect(txCalls[0]).toBe(1);
  });

  it('flips status to posted, stamps postedBy / postedAt', async () => {
    const { svc, headersRepo } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
    });
    const result = await svc.post(GRN_ID, TENANT, USER);
    expect(result.grn.status).toBe('posted');
    const guardCall = (headersRepo.updateStatusGuarded as jest.Mock).mock.calls[0];
    expect(guardCall[1]).toEqual(['draft', 'pending_review']);
    expect(guardCall[2]).toMatchObject({
      status: 'posted',
      postedBy: USER,
    });
    expect(guardCall[2].postedAt).toBeInstanceOf(Date);
  });

  it('emits exactly one inventory inbound per item', async () => {
    const { svc, inventory } = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ id: 'a' }), baseItem({ id: 'b' }), baseItem({ id: 'c' })],
    });
    await svc.post(GRN_ID, TENANT, USER);
    expect((inventory.applyInbound as jest.Mock).mock.calls).toHaveLength(3);
  });

  it('creates one expiry record per item with expiryDate', async () => {
    const { svc, expiryService } = buildSvc({
      grn: baseGrn(),
      items: [
        baseItem({ id: 'a' }), // has expiryDate
        baseItem({ id: 'b', expiryDate: null }), // no expiry
      ],
    });
    const result = await svc.post(GRN_ID, TENANT, USER);
    expect((expiryService.createRecord as jest.Mock).mock.calls).toHaveLength(1);
    expect(result.expiryRecordsCreated).toBe(1);
  });

  it('appends a posted event row inside the transaction', async () => {
    const { svc, eventsRepo } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
    });
    await svc.post(GRN_ID, TENANT, USER);
    const evt = (eventsRepo.create as jest.Mock).mock.calls[0][0];
    expect(evt.type).toBe('posted');
    expect(evt.actorId).toBe(USER);
  });

  it('audit-logs the post action with transition=post metadata', async () => {
    const { svc, auditLog } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
    });
    await svc.post(GRN_ID, TENANT, USER);
    const call = (auditLog.logAction as jest.Mock).mock.calls[0][0];
    expect(call).toMatchObject({
      action: 'CREATE',
      resourceType: 'GrnPosting',
      tenantId: TENANT,
      userId: USER,
      success: true,
    });
    expect(call.metadata.transition).toBe('post');
  });

  it('auto-creates a product when EAN not in catalog', async () => {
    const { svc, productsRepo } = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ productId: null, ean: '8901111111111' })],
    });
    await svc.post(GRN_ID, TENANT, USER);
    expect(productsRepo.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        ean: '8901111111111',
        status: 'pending_review',
        dataSource: 'grn',
        tenantId: TENANT,
      }),
      expect.anything(),
    );
  });

  it('rolls back the transaction when inventory throws', async () => {
    const { svc, eventsRepo, headersRepo } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
      inventoryThrows: true,
    });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toThrow(/inventory blew up/);
    // Status guard must not have been reached.
    expect(headersRepo.updateStatusGuarded as jest.Mock).not.toHaveBeenCalled();
    // No posted event ever created.
    expect(eventsRepo.create as jest.Mock).not.toHaveBeenCalled();
  });

  it('throws GRN_ALREADY_POSTED when the optimistic guard returns null (concurrent post)', async () => {
    const { svc } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
      guardReturnsNull: true,
    });
    await expect(svc.post(GRN_ID, TENANT, USER)).rejects.toMatchObject({
      code: ErrorCode.GRN_ALREADY_POSTED,
    });
  });

  it('counts short-shelf-life items (< 30 days)', async () => {
    const fiveDays = new Date(Date.now() + 5 * 86_400_000);
    const sixtyDays = new Date(Date.now() + 60 * 86_400_000);
    const { svc, expiryService, headersRepo } = buildSvc({
      grn: baseGrn(),
      items: [
        baseItem({ id: 'short', expiryDate: fiveDays }),
        baseItem({ id: 'long', expiryDate: sixtyDays }),
      ],
    });
    let n = 0;
    (expiryService.createRecord as jest.Mock).mockImplementation(async () => {
      n += 1;
      return { id: `e${n}`, daysRemaining: n === 1 ? 5 : 60 };
    });
    await svc.post(GRN_ID, TENANT, USER);
    const guardPatch = (headersRepo.updateStatusGuarded as jest.Mock).mock.calls[0][2];
    expect(guardPatch.shortShelfLifeCount).toBe(1);
    expect(guardPatch.minExpiryRemainingDays).toBe(5);
  });

  it('publishes supplier performance metrics post-commit (best effort)', async () => {
    const { svc, supplierPerf } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
    });
    await svc.post(GRN_ID, TENANT, USER);
    // Supplier metric publish is non-blocking — give the microtask
    // queue a tick to flush.
    await new Promise((r) => setImmediate(r));
    expect(supplierPerf.updateMetrics as jest.Mock).toHaveBeenCalled();
  });
});
