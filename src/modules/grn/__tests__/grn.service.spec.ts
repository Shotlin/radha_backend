import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { GrnService } from '../grn.service';
import { GrnEventsRepository } from '../repositories/grn-events.repository';
import { GrnHeadersRepository } from '../repositories/grn-headers.repository';
import { GrnItemsRepository } from '../repositories/grn-items.repository';
import { GrnPostingService } from '../services/grn-posting.service';
import { GrnReversalService } from '../services/grn-reversal.service';
import { GrnValidationService } from '../services/grn-validation.service';
import type { Grn, GrnItem, ISupplierLookupService, SupplierLookupRow } from '../types/grn.types';
import { GrnNumberGenerator } from '../utils/grn-number-generator.utils';

const TENANT = 'tenant-1';
const USER = 'user-1';
const STORE = '00000000-0000-0000-0000-000000000aaa';
const SUPPLIER = '00000000-0000-0000-0000-000000000bbb';
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
    supplierId: SUPPLIER,
    invoiceNumber: 'INV-1',
    invoiceDate: new Date('2026-06-01'),
    poNumber: null,
    inwardDate: new Date('2026-06-05'),
    expectedDeliveryDate: null,
    orderDate: null,
    status: 'draft',
    subtotal: null,
    taxAmount: null,
    totalAmount: null,
    totalItems: 0,
    totalQuantity: 0,
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
    createdBy: null,
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
    productNameSnapshot: 'Test',
    quantity: 5,
    unit: 'pcs',
    batchNumber: null,
    manufactureDate: null,
    expiryDate: null,
    expiryRemainingDays: null,
    unitPrice: null,
    taxPercent: null,
    totalPrice: null,
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
  supplier?: SupplierLookupRow | null;
  duplicateInvoice?: Grn | null;
  grn?: Grn | null;
  items?: GrnItem[];
  guardReturnsNull?: boolean;
  itemDeleted?: boolean;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const db: DbService = {
    transaction: jest.fn(async (cb) => cb({})),
  } as unknown as DbService;

  const headersRepo = {
    findByIdInTenant: jest.fn(async () => opts.grn ?? null),
    findByInvoice: jest.fn(async () => opts.duplicateInvoice ?? null),
    create: jest.fn(async (data: Partial<Grn>) => baseGrn({ id: 'created', ...data })),
    update: jest.fn(async (id: string, data: Partial<Grn>) =>
      baseGrn({ ...(opts.grn ?? {}), ...data, id }),
    ),
    updateStatusGuarded: jest.fn(async (id: string, _froms: unknown, patch: Partial<Grn>) =>
      opts.guardReturnsNull ? null : baseGrn({ ...(opts.grn ?? {}), ...patch, id }),
    ),
  } as unknown as GrnHeadersRepository;

  const itemsRepo = {
    create: jest.fn(async (data: Partial<GrnItem>) =>
      baseItem({ id: `item-${Math.random()}`, ...data }),
    ),
    findByGrn: jest.fn(async () => opts.items ?? []),
    findByIdInGrn: jest.fn(async () => (opts.items ? opts.items[0] : null)),
    deleteForGrn: jest.fn(async () => opts.itemDeleted ?? true),
    update: jest.fn(async (id: string, data: Partial<GrnItem>) => baseItem({ id, ...data })),
  } as unknown as GrnItemsRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
    findByGrn: jest.fn(async () => []),
  } as unknown as GrnEventsRepository;

  const numberGenerator = {
    generateForStore: jest.fn(async () => 'GRN-XYZ-202606-0001'),
  } as unknown as GrnNumberGenerator;

  const postingService = {
    post: jest.fn(),
  } as unknown as GrnPostingService;

  const reversalService = {
    reverse: jest.fn(),
  } as unknown as GrnReversalService;

  const validationService = {
    validate: jest.fn(async () => ({ valid: true, errors: [], warnings: [] })),
  } as unknown as GrnValidationService;

  const supplierLookup: ISupplierLookupService = {
    findById: jest.fn(async () =>
      opts.supplier === undefined
        ? ({
            id: SUPPLIER,
            tenantId: TENANT,
            name: 'Acme',
            status: 'active',
          } as SupplierLookupRow)
        : opts.supplier,
    ),
  };

  const auditLog = {
    logAction: jest.fn(async () => undefined),
  } as unknown as AuditLogService;

  const svc = new GrnService(
    db,
    headersRepo,
    itemsRepo,
    eventsRepo,
    postingService,
    reversalService,
    validationService,
    numberGenerator,
    auditLog,
    buildLogger(),
    supplierLookup,
  );

  return {
    svc,
    headersRepo,
    itemsRepo,
    eventsRepo,
    auditLog,
    numberGenerator,
    postingService,
    reversalService,
    supplierLookup,
  };
};

describe('GrnService.createDraft', () => {
  const dto = {
    supplierId: SUPPLIER,
    storeId: STORE,
    invoiceNumber: 'INV-1',
    invoiceDate: new Date('2026-06-01'),
    inwardDate: new Date('2026-06-05'),
  };

  it('throws when supplier missing', async () => {
    const { svc } = buildSvc({ supplier: null });
    await expect(svc.createDraft(TENANT, USER, dto)).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('throws 404 when supplier belongs to a different tenant', async () => {
    const { svc } = buildSvc({
      supplier: {
        id: SUPPLIER,
        tenantId: 'different-tenant',
        name: 'X',
        status: 'active',
      },
    });
    await expect(svc.createDraft(TENANT, USER, dto)).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects when supplier is blacklisted', async () => {
    const { svc } = buildSvc({
      supplier: {
        id: SUPPLIER,
        tenantId: TENANT,
        name: 'X',
        status: 'blacklisted',
      },
    });
    await expect(svc.createDraft(TENANT, USER, dto)).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects when supplier is inactive', async () => {
    const { svc } = buildSvc({
      supplier: {
        id: SUPPLIER,
        tenantId: TENANT,
        name: 'X',
        status: 'inactive',
      },
    });
    await expect(svc.createDraft(TENANT, USER, dto)).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects duplicate invoice for same supplier with 409', async () => {
    const { svc } = buildSvc({
      duplicateInvoice: baseGrn({ id: 'existing' }),
    });
    await expect(svc.createDraft(TENANT, USER, dto)).rejects.toBeInstanceOf(
      DomainConflictException,
    );
  });

  it('creates a draft with auto-generated GRN number and audit log', async () => {
    const { svc, headersRepo, eventsRepo, auditLog } = buildSvc();
    const out = await svc.createDraft(TENANT, USER, dto);
    expect(out.id).toBe('created');
    expect(headersRepo.create as jest.Mock).toHaveBeenCalled();
    const headerArg = (headersRepo.create as jest.Mock).mock.calls[0][0];
    expect(headerArg.grnNumber).toBe('GRN-XYZ-202606-0001');
    expect(headerArg.status).toBe('draft');
    expect(headerArg.tenantId).toBe(TENANT);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('created');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0]).toMatchObject({
      action: 'CREATE',
      resourceType: 'Grn',
    });
  });

  it('creates initial items when provided in dto', async () => {
    const { svc, itemsRepo } = buildSvc();
    await svc.createDraft(TENANT, USER, {
      ...dto,
      items: [
        { ean: '8901234567890', quantity: 5, unit: 'pcs' },
        { ean: '8901111111111', quantity: 2, unit: 'pcs' },
      ],
    });
    expect((itemsRepo.create as jest.Mock).mock.calls).toHaveLength(2);
  });
});

describe('GrnService.updateDraft', () => {
  it('rejects edits on posted GRNs', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'posted' }) });
    await expect(svc.updateDraft(TENANT, USER, GRN_ID, { notes: 'edit' })).rejects.toMatchObject({
      code: ErrorCode.GRN_ALREADY_POSTED,
    });
  });

  it('rejects edits on cancelled or reversed GRNs', async () => {
    const cancelled = buildSvc({ grn: baseGrn({ status: 'cancelled' }) });
    await expect(
      cancelled.svc.updateDraft(TENANT, USER, GRN_ID, { notes: 'x' }),
    ).rejects.toBeInstanceOf(BusinessException);

    const reversed = buildSvc({ grn: baseGrn({ status: 'reversed' }) });
    await expect(
      reversed.svc.updateDraft(TENANT, USER, GRN_ID, { notes: 'x' }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('updates a draft and emits an updated event', async () => {
    const { svc, eventsRepo, auditLog } = buildSvc({ grn: baseGrn() });
    await svc.updateDraft(TENANT, USER, GRN_ID, { notes: 'updated' });
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('updated');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0].metadata.transition).toBe('edit');
  });
});

describe('GrnService.addItems', () => {
  it('rejects adding items to a posted GRN', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'posted' }) });
    await expect(
      svc.addItems(TENANT, USER, GRN_ID, [{ ean: '8901234567890', quantity: 1, unit: 'pcs' }]),
    ).rejects.toMatchObject({ code: ErrorCode.GRN_ALREADY_POSTED });
  });

  it('appends items and refreshes header counters', async () => {
    const { svc, headersRepo, eventsRepo } = buildSvc({
      grn: baseGrn({ totalItems: 0, totalQuantity: 0 }),
    });
    const created = await svc.addItems(TENANT, USER, GRN_ID, [
      { ean: '8901234567890', quantity: 5, unit: 'pcs' },
      { ean: '8901111111111', quantity: 3, unit: 'pcs' },
    ]);
    expect(created).toHaveLength(2);
    const counterUpdate = (headersRepo.update as jest.Mock).mock.calls[0][1];
    expect(counterUpdate.totalItems).toBe(2);
    expect(counterUpdate.totalQuantity).toBe(8);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('item_added');
  });
});

describe('GrnService.removeItem', () => {
  it('rejects when item not found', async () => {
    const { svc } = buildSvc({
      grn: baseGrn(),
      itemDeleted: false,
    });
    await expect(svc.removeItem(TENANT, USER, GRN_ID, 'missing')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('removes an item and refreshes header counters', async () => {
    const { svc, headersRepo, eventsRepo } = buildSvc({
      grn: baseGrn({ totalItems: 2, totalQuantity: 8 }),
      items: [baseItem({ id: 'remaining', quantity: 3 })],
      itemDeleted: true,
    });
    await svc.removeItem(TENANT, USER, GRN_ID, 'item-to-remove');
    const counterUpdate = (headersRepo.update as jest.Mock).mock.calls[0][1];
    expect(counterUpdate.totalItems).toBe(1);
    expect(counterUpdate.totalQuantity).toBe(3);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('item_removed');
  });
});

describe('GrnService.cancel', () => {
  it('throws when GRN missing', async () => {
    const { svc } = buildSvc({ grn: null });
    await expect(svc.cancel(TENANT, USER, GRN_ID, 'why')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects cancelling a posted GRN with GRN_ALREADY_POSTED', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'posted' }) });
    await expect(svc.cancel(TENANT, USER, GRN_ID, 'why')).rejects.toMatchObject({
      code: ErrorCode.GRN_ALREADY_POSTED,
    });
  });

  it('rejects cancelling an already-cancelled GRN', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'cancelled' }) });
    await expect(svc.cancel(TENANT, USER, GRN_ID, 'why')).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects cancelling a reversed GRN', async () => {
    const { svc } = buildSvc({ grn: baseGrn({ status: 'reversed' }) });
    await expect(svc.cancel(TENANT, USER, GRN_ID, 'why')).rejects.toBeInstanceOf(BusinessException);
  });

  it('cancels a draft, audit-logs, emits cancelled event with reason', async () => {
    const { svc, eventsRepo, auditLog } = buildSvc({ grn: baseGrn() });
    await svc.cancel(TENANT, USER, GRN_ID, 'wrong supplier');
    const evt = (eventsRepo.create as jest.Mock).mock.calls[0][0];
    expect(evt.type).toBe('cancelled');
    expect(evt.notes).toBe('wrong supplier');
    expect((auditLog.logAction as jest.Mock).mock.calls[0][0]).toMatchObject({
      action: 'UPDATE',
      metadata: { transition: 'cancel', reason: 'wrong supplier' },
    });
  });

  it('surfaces a clean error if the optimistic guard rejects (concurrent change)', async () => {
    const { svc } = buildSvc({
      grn: baseGrn(),
      guardReturnsNull: true,
    });
    await expect(svc.cancel(TENANT, USER, GRN_ID, 'why')).rejects.toBeInstanceOf(BusinessException);
  });
});

describe('GrnService delegation', () => {
  it('delegates post() to GrnPostingService', async () => {
    const { svc, postingService } = buildSvc();
    await svc.post(TENANT, USER, GRN_ID).catch(() => undefined);
    expect(postingService.post as jest.Mock).toHaveBeenCalledWith(GRN_ID, TENANT, USER);
  });

  it('delegates reverse() to GrnReversalService', async () => {
    const { svc, reversalService } = buildSvc();
    await svc.reverse(TENANT, USER, GRN_ID, 'damage').catch(() => undefined);
    expect(reversalService.reverse as jest.Mock).toHaveBeenCalledWith(
      GRN_ID,
      TENANT,
      USER,
      'damage',
    );
  });
});

describe('GrnService.findById', () => {
  it('throws 404 when missing in tenant', async () => {
    const { svc } = buildSvc({ grn: null });
    await expect(svc.findById(TENANT, GRN_ID)).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('returns header + items + events when present', async () => {
    const { svc } = buildSvc({
      grn: baseGrn(),
      items: [baseItem()],
    });
    const out = await svc.findById(TENANT, GRN_ID);
    expect(out.id).toBe(GRN_ID);
    expect(out.items).toHaveLength(1);
  });
});
