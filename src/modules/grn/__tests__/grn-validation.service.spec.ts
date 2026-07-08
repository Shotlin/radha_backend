import { ProductsRepository } from '@/modules/products/products.repository';

import { GrnHeadersRepository } from '../repositories/grn-headers.repository';
import { GrnItemsRepository } from '../repositories/grn-items.repository';
import { GrnValidationService } from '../services/grn-validation.service';
import type { Grn, GrnItem } from '../types/grn.types';

const TENANT = 'tenant-1';
const GRN_ID = 'grn-1';
const STORE = 'store-1';
const SUPPLIER = 'supplier-1';

const baseGrn = (over: Partial<Grn> = {}): Grn =>
  ({
    id: GRN_ID,
    tenantId: TENANT,
    storeId: STORE,
    grnNumber: 'GRN-XYZ-0001',
    supplierId: SUPPLIER,
    invoiceNumber: 'INV-1',
    invoiceDate: new Date('2026-06-01'),
    poNumber: null,
    inwardDate: new Date('2026-06-02'),
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
    productNameSnapshot: 'Test Product',
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

const buildSvc = (opts: {
  grn?: Grn | null;
  items?: GrnItem[];
  productByEan?: Record<string, { id: string } | null>;
}) => {
  const headers = {
    findByIdInTenant: jest.fn(async () => opts.grn ?? null),
  } as unknown as GrnHeadersRepository;
  const items = {
    findByGrn: jest.fn(async () => opts.items ?? []),
  } as unknown as GrnItemsRepository;
  const products = {
    findVisibleByEan: jest.fn(async (ean: string) => (opts.productByEan ?? {})[ean] ?? null),
  } as unknown as ProductsRepository;
  return new GrnValidationService(headers, items, products);
};

describe('GrnValidationService.validate', () => {
  it('returns invalid when GRN not found', async () => {
    const svc = buildSvc({ grn: null });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ field: 'id' });
  });

  it('errors when GRN has no items', async () => {
    const svc = buildSvc({ grn: baseGrn(), items: [] });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'items')).toBe(true);
  });

  it('errors on negative or zero quantity', async () => {
    const svc = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ id: 'a', quantity: 0 }), baseItem({ id: 'b', quantity: -3 })],
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.valid).toBe(false);
    expect(result.errors.filter((e) => e.field === 'quantity')).toHaveLength(2);
  });

  it('errors when expiry is on or before manufacture date', async () => {
    const svc = buildSvc({
      grn: baseGrn(),
      items: [
        baseItem({
          manufactureDate: new Date('2026-12-31'),
          expiryDate: new Date('2026-12-31'),
        }),
      ],
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.valid).toBe(false);
    expect(result.errors.find((e) => e.field === 'expiryDate')).toBeDefined();
  });

  it('warns on past expiry but does not error', async () => {
    const svc = buildSvc({
      grn: baseGrn(),
      items: [
        baseItem({
          expiryDate: new Date('2020-01-01'),
        }),
      ],
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.valid).toBe(true);
    expect(result.warnings.find((w) => w.type === 'past_expiry')).toBeDefined();
  });

  it('warns on short shelf life (< 30 days)', async () => {
    const inFiveDays = new Date(Date.now() + 5 * 86_400_000);
    const svc = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ expiryDate: inFiveDays })],
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.valid).toBe(true);
    expect(result.warnings.find((w) => w.type === 'short_shelf_life')).toBeDefined();
  });

  it('does not warn for items > 30 days from expiry', async () => {
    const inSixtyDays = new Date(Date.now() + 60 * 86_400_000);
    const svc = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ expiryDate: inSixtyDays })],
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(
      result.warnings.find((w) => w.type === 'short_shelf_life' || w.type === 'past_expiry'),
    ).toBeUndefined();
  });

  it('warns on duplicate batch within the same GRN', async () => {
    const svc = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ id: 'a', batchNumber: 'B01' }), baseItem({ id: 'b', batchNumber: 'B01' })],
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.warnings.find((w) => w.type === 'duplicate_batch')).toBeDefined();
  });

  it('warns on unknown product (no productId, EAN not in catalog)', async () => {
    const svc = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ productId: null, ean: '8901111111111' })],
      productByEan: { '8901111111111': null },
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.warnings.find((w) => w.type === 'unknown_product')).toBeDefined();
  });

  it('does not warn on unknown product when EAN resolves in catalog', async () => {
    const svc = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ productId: null })],
      productByEan: { '8901234567890': { id: 'product-1' } },
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.warnings.find((w) => w.type === 'unknown_product')).toBeUndefined();
  });

  it('valid when everything passes', async () => {
    const svc = buildSvc({
      grn: baseGrn(),
      items: [baseItem({ quantity: 10 })],
    });
    const result = await svc.validate(GRN_ID, TENANT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
