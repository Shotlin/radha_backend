import * as xlsx from 'xlsx';

import { DbService } from '@/db/db.service';
import type { SupplierRow } from '@/db/schema/suppliers';

import type { SuppliersRepository } from '../repositories/suppliers.repository';
import { SupplierImportService } from '../services/supplier-import.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACTOR = '22222222-2222-2222-2222-222222222222';

const buildBuffer = (rows: Array<Record<string, string | number>>): Buffer => {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, 'Suppliers');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

const buildSvc = (
  overrides: {
    byCode?: Map<string, SupplierRow>;
    byGst?: Map<string, SupplierRow>;
  } = {},
) => {
  const byCode = overrides.byCode ?? new Map<string, SupplierRow>();
  const byGst = overrides.byGst ?? new Map<string, SupplierRow>();

  const repo = {
    findByCodeInTenant: jest.fn(async (code: string) => byCode.get(code) ?? null),
    findByGstInTenant: jest.fn(async (gst: string) => byGst.get(gst) ?? null),
    bulkCreate: jest.fn(async (rows: unknown[]) => rows),
  } as unknown as SuppliersRepository;

  const db = {
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  } as unknown as DbService;

  return { repo, svc: new SupplierImportService(db, repo) };
};

describe('SupplierImportService.processBuffer', () => {
  it('returns failure-only counts when every row is invalid (e.g. missing name)', async () => {
    const { svc } = buildSvc();
    const fallback = buildBuffer([{ name: '', country: 'IN' }]);
    const result = await svc.processBuffer(TENANT, ACTOR, 'xlsx', fallback);
    expect(result.totalRows).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('imports valid rows and produces a per-row error list for invalid rows', async () => {
    const { svc, repo } = buildSvc();
    const buf = buildBuffer([
      { name: 'Acme Foods', code: 'SUP-ACME-1', country: 'IN' },
      { name: 'Beta Distributors', code: 'SUP-BETA-1', country: 'IN' },
      { name: '', code: 'SUP-EMPTY', country: 'IN' }, // empty name → fails
    ]);
    const result = await svc.processBuffer(TENANT, ACTOR, 'xlsx', buf);
    expect(result.totalRows).toBe(3);
    expect(result.imported).toBe(2);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].row).toBe(4); // header + index 3
    expect(repo.bulkCreate as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('skips a row whose code already exists', async () => {
    const taken = new Map<string, SupplierRow>();
    taken.set('SUP-DUP-1', { id: 'x' } as SupplierRow);
    const { svc } = buildSvc({ byCode: taken });
    const buf = buildBuffer([
      { name: 'Dup Supplier', code: 'SUP-DUP-1', country: 'IN' },
      { name: 'New Supplier', code: 'SUP-NEW-1', country: 'IN' },
    ]);
    const result = await svc.processBuffer(TENANT, ACTOR, 'xlsx', buf);
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('flags duplicate codes within the same upload as failed', async () => {
    const { svc } = buildSvc();
    const buf = buildBuffer([
      { name: 'A', code: 'SUP-SAME-1', country: 'IN' },
      { name: 'B', code: 'SUP-SAME-1', country: 'IN' },
    ]);
    const result = await svc.processBuffer(TENANT, ACTOR, 'xlsx', buf);
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toMatch(/Duplicate code/i);
  });

  it('skips when GST clashes with an existing supplier', async () => {
    const gstClash = new Map<string, SupplierRow>();
    gstClash.set('27AAPFU0939F1ZV', { id: 'existing' } as SupplierRow);
    const { svc } = buildSvc({ byGst: gstClash });
    const buf = buildBuffer([
      {
        name: 'GST Clash',
        code: 'SUP-GST-1',
        gst: '27AAPFU0939F1ZV',
        country: 'IN',
      },
    ]);
    const result = await svc.processBuffer(TENANT, ACTOR, 'xlsx', buf);
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('rejects malformed GST per row without aborting the file', async () => {
    const { svc } = buildSvc();
    const buf = buildBuffer([
      { name: 'Bad GST', gst: 'NOT-A-GST', country: 'IN' },
      { name: 'Good Row', country: 'IN' },
    ]);
    const result = await svc.processBuffer(TENANT, ACTOR, 'xlsx', buf);
    expect(result.failed).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.errors.find((e) => e.field === 'gstNumber')).toBeDefined();
  });
});

describe('SupplierImportService.mapRow', () => {
  it('maps common header aliases to canonical fields', () => {
    const { svc } = buildSvc();
    const result = svc.mapRow({
      rowNumber: 2,
      data: {
        supplier_name: 'Hello',
        gstin: '27AAPFU0939F1ZV',
        mobile: '9876543210',
        zip: '400001',
        min_order: '5,000',
      },
    });
    expect(result.name).toBe('Hello');
    expect(result.gstNumber).toBe('27AAPFU0939F1ZV');
    expect(result.phone).toBe('9876543210');
    expect(result.pincode).toBe('400001');
    expect(result.minimumOrderAmount).toBe(5000);
  });
});
