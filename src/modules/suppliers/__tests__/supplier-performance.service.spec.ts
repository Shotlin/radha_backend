import { DomainNotFoundException } from '@/common/errors/business.exception';
import type { SupplierRow } from '@/db/schema/suppliers';

import type { SuppliersRepository } from '../repositories/suppliers.repository';
import { SupplierPerformanceService } from '../services/supplier-performance.service';

const TENANT = 'tenant-1';
const SUPPLIER = 'supp-1';

const baseSupplier = (over: Partial<SupplierRow> = {}): SupplierRow =>
  ({
    id: SUPPLIER,
    tenantId: TENANT,
    name: 'Acme',
    code: 'SUP-1',
    status: 'active',
    country: 'IN',
    totalGrns: 0,
    averageDeliveryDays: null,
    qualityScore: null,
    reliabilityScore: null,
    shortShelfLifeIncidents: 0,
    lastDeliveryDate: null,
    totalAmountDelivered: '0',
    metadata: {},
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as SupplierRow;

const buildSvc = (supplier: SupplierRow | null) => {
  const repo = {
    findByIdInTenant: jest.fn(async () => supplier),
    refreshPerformanceCounters: jest.fn(async () => undefined),
  } as unknown as SuppliersRepository;

  // The DB service is only used for the ledger aggregate query;
  // wire a minimal stub that returns an empty result.
  const db = {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([{ avgExpiry: null, latest: null }] as Array<{
              avgExpiry: string | null;
              latest: Date | null;
            }>),
        }),
      }),
    }),
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  };

  return {
    repo,
    svc: new SupplierPerformanceService(db as unknown as import('@/db/db.service').DbService, repo),
  };
};

describe('SupplierPerformanceService.computeReliabilityScore', () => {
  const { svc } = buildSvc(baseSupplier());

  it('returns 50 when totalGrns = 0', () => {
    expect(svc.computeReliabilityScore(0, 0)).toBe(50);
  });

  it('returns 100 when no short-shelf-life incidents', () => {
    expect(svc.computeReliabilityScore(0, 10)).toBe(100);
  });

  it('returns 0 when every GRN was short-shelf-life', () => {
    expect(svc.computeReliabilityScore(10, 10)).toBe(0);
  });

  it('penalises proportionally', () => {
    expect(svc.computeReliabilityScore(2, 10)).toBe(80);
    expect(svc.computeReliabilityScore(5, 10)).toBe(50);
  });

  it('clamps to [0, 100] even with bogus inputs', () => {
    expect(svc.computeReliabilityScore(20, 10)).toBe(0);
    expect(svc.computeReliabilityScore(-5, 10)).toBe(100);
  });
});

describe('SupplierPerformanceService.compose', () => {
  it('builds the wire shape with sane fallbacks for a brand-new supplier', () => {
    const { svc } = buildSvc(null);
    const result = svc.compose(baseSupplier(), {
      avgExpiry: 0,
      latestFromLedger: null,
    });
    expect(result.totalGrns).toBe(0);
    expect(result.qualityScore).toBe(75);
    expect(result.reliabilityScore).toBe(50);
    expect(result.lastDeliveryDate).toBeNull();
  });

  it('uses the supplier-stored reliability when present', () => {
    const { svc } = buildSvc(null);
    const result = svc.compose(baseSupplier({ reliabilityScore: 88, totalGrns: 5 }), {
      avgExpiry: 60,
      latestFromLedger: null,
    });
    expect(result.reliabilityScore).toBe(88);
  });

  it('falls back to the ledger latest when supplier has no recorded delivery', () => {
    const { svc } = buildSvc(null);
    const ledgerDate = new Date('2026-01-15T00:00:00Z');
    const result = svc.compose(baseSupplier(), {
      avgExpiry: 30,
      latestFromLedger: ledgerDate,
    });
    expect(result.lastDeliveryDate).toEqual(ledgerDate);
  });
});

describe('SupplierPerformanceService.getPerformance', () => {
  it('throws when supplier missing', async () => {
    const { svc } = buildSvc(null);
    await expect(svc.getPerformance(TENANT, SUPPLIER)).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('returns a performance view for an existing supplier', async () => {
    const { svc } = buildSvc(baseSupplier({ totalGrns: 4 }));
    const result = await svc.getPerformance(TENANT, SUPPLIER);
    expect(result.supplierId).toBe(SUPPLIER);
    expect(result.totalGrns).toBe(4);
  });
});
