import {
  AddItemsSchema,
  CancelGrnSchema,
  CreateGrnSchema,
  GrnItemSchema,
  ListGrnsQuerySchema,
  ReverseGrnSchema,
  UpdateGrnItemSchema,
  UpdateGrnSchema,
} from '../dto/grn.dto';

const SUPPLIER = '00000000-0000-0000-0000-000000000001';
const STORE = '00000000-0000-0000-0000-000000000002';
const PRODUCT = '00000000-0000-0000-0000-000000000003';

describe('GrnItemSchema', () => {
  const valid = { ean: '8901234567890', quantity: 5 };

  it('accepts a minimal valid payload and applies defaults', () => {
    const out = GrnItemSchema.parse(valid);
    expect(out.unit).toBe('pcs');
    expect(out.quantity).toBe(5);
  });

  it('rejects negative quantity', () => {
    expect(() => GrnItemSchema.parse({ ...valid, quantity: -1 })).toThrow(/> 0/);
  });

  it('rejects zero quantity', () => {
    expect(() => GrnItemSchema.parse({ ...valid, quantity: 0 })).toThrow(/> 0/);
  });

  it('rejects non-integer quantity', () => {
    expect(() => GrnItemSchema.parse({ ...valid, quantity: 1.5 })).toThrow();
  });

  it('rejects malformed EAN (non-digits)', () => {
    expect(() => GrnItemSchema.parse({ ...valid, ean: 'abc12345' })).toThrow();
  });

  it('rejects EAN shorter than 8 digits', () => {
    expect(() => GrnItemSchema.parse({ ...valid, ean: '1234567' })).toThrow();
  });

  it('rejects EAN longer than 13 digits', () => {
    expect(() => GrnItemSchema.parse({ ...valid, ean: '12345678901234' })).toThrow();
  });

  it('accepts EAN-8', () => {
    expect(() => GrnItemSchema.parse({ ...valid, ean: '12345670' })).not.toThrow();
  });

  it('rejects expiry before manufacture date', () => {
    expect(() =>
      GrnItemSchema.parse({
        ...valid,
        manufactureDate: '2026-12-31',
        expiryDate: '2026-01-01',
      }),
    ).toThrow(/expiryDate must be after manufactureDate/);
  });

  it('accepts expiry after manufacture date', () => {
    expect(() =>
      GrnItemSchema.parse({
        ...valid,
        manufactureDate: '2026-01-01',
        expiryDate: '2026-12-31',
      }),
    ).not.toThrow();
  });

  it('coerces date strings into Date objects', () => {
    const out = GrnItemSchema.parse({
      ...valid,
      expiryDate: '2027-06-30',
    });
    expect(out.expiryDate).toBeInstanceOf(Date);
  });

  it('caps unitPrice', () => {
    expect(() => GrnItemSchema.parse({ ...valid, unitPrice: 1_000_000_001 })).toThrow();
  });
});

describe('UpdateGrnItemSchema', () => {
  it('accepts partial updates', () => {
    expect(() => UpdateGrnItemSchema.parse({ quantity: 10 })).not.toThrow();
    expect(() => UpdateGrnItemSchema.parse({ batchNumber: 'B01' })).not.toThrow();
  });

  it('rejects invalid date ordering', () => {
    expect(() =>
      UpdateGrnItemSchema.parse({
        manufactureDate: '2026-12-31',
        expiryDate: '2026-01-01',
      }),
    ).toThrow();
  });
});

describe('AddItemsSchema', () => {
  it('rejects empty items array', () => {
    expect(() => AddItemsSchema.parse({ items: [] })).toThrow();
  });

  it('caps items at 200', () => {
    const items = Array.from({ length: 201 }, () => ({
      ean: '8901234567890',
      quantity: 1,
    }));
    expect(() => AddItemsSchema.parse({ items })).toThrow();
  });

  it('accepts a list of valid items', () => {
    const out = AddItemsSchema.parse({
      items: [{ ean: '8901234567890', quantity: 1 }],
    });
    expect(out.items).toHaveLength(1);
  });
});

describe('CreateGrnSchema', () => {
  const valid = {
    supplierId: SUPPLIER,
    storeId: STORE,
    invoiceNumber: 'INV-001',
    invoiceDate: '2026-06-01',
    inwardDate: '2026-06-02',
  };

  it('accepts a minimal valid payload', () => {
    expect(() => CreateGrnSchema.parse(valid)).not.toThrow();
  });

  it('rejects empty invoiceNumber', () => {
    expect(() => CreateGrnSchema.parse({ ...valid, invoiceNumber: '   ' })).toThrow();
  });

  it('rejects inward date before order date', () => {
    expect(() =>
      CreateGrnSchema.parse({
        ...valid,
        orderDate: '2026-06-10',
        inwardDate: '2026-06-05',
      }),
    ).toThrow(/inwardDate must be on or after orderDate/);
  });

  it('accepts items at draft creation time', () => {
    const out = CreateGrnSchema.parse({
      ...valid,
      items: [{ ean: '8901234567890', quantity: 5, productId: PRODUCT }],
    });
    expect(out.items).toHaveLength(1);
  });
});

describe('UpdateGrnSchema', () => {
  it('accepts a partial payload', () => {
    expect(() => UpdateGrnSchema.parse({ notes: 'updated' })).not.toThrow();
  });
});

describe('CancelGrnSchema', () => {
  it('requires a reason', () => {
    expect(() => CancelGrnSchema.parse({ reason: '' })).toThrow();
  });

  it('accepts a reason', () => {
    expect(() => CancelGrnSchema.parse({ reason: 'wrong supplier' })).not.toThrow();
  });
});

describe('ReverseGrnSchema', () => {
  it('requires a reason', () => {
    expect(() => ReverseGrnSchema.parse({})).toThrow();
  });

  it('caps the reason at 500 chars', () => {
    expect(() => ReverseGrnSchema.parse({ reason: 'x'.repeat(501) })).toThrow();
  });
});

describe('ListGrnsQuerySchema', () => {
  it('parses CSV status into array', () => {
    const out = ListGrnsQuerySchema.parse({ status: 'draft,posted' });
    expect(out.status).toEqual(['draft', 'posted']);
  });

  it('drops unknown statuses silently', () => {
    const out = ListGrnsQuerySchema.parse({ status: 'foo,posted' });
    expect(out.status).toEqual(['posted']);
  });

  it('caps limit at 200', () => {
    expect(() => ListGrnsQuerySchema.parse({ limit: 9999 })).toThrow();
  });

  it('defaults limit to 50', () => {
    const out = ListGrnsQuerySchema.parse({});
    expect(out.limit).toBe(50);
  });
});
