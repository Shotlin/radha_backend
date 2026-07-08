import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import type { SupplierContactRow, SupplierRow } from '@/db/schema/suppliers';
import { AuditLogService } from '@/observability/audit-log.service';

import type { CreateSupplierDto } from '../dto/create-supplier.dto';
import type { SupplierContactsRepository } from '../repositories/supplier-contacts.repository';
import type { SuppliersRepository } from '../repositories/suppliers.repository';
import type { SupplierImportService } from '../services/supplier-import.service';
import type { SupplierPerformanceService } from '../services/supplier-performance.service';
import { SuppliersService } from '../suppliers.service';
import type { SupplierPerformance } from '../types/supplier.types';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACTOR = '22222222-2222-2222-2222-222222222222';
const SUPPLIER_ID = '33333333-3333-3333-3333-333333333333';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildAudit = (): AuditLogService =>
  ({ logAction: jest.fn(async () => undefined) }) as unknown as AuditLogService;

const dbThatRunsCallback = (): DbService =>
  ({
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  }) as unknown as DbService;

const baseSupplier = (over: Partial<SupplierRow> = {}): SupplierRow =>
  ({
    id: SUPPLIER_ID,
    tenantId: TENANT,
    name: 'Acme Distributors',
    legalName: null,
    code: 'SUP-ACME-001',
    gstNumber: null,
    panNumber: null,
    category: null,
    description: null,
    status: 'active',
    blacklistReason: null,
    blacklistedAt: null,
    email: null,
    phone: null,
    alternatePhone: null,
    whatsappNumber: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    pincode: null,
    country: 'IN',
    paymentTerms: null,
    deliveryDays: null,
    minimumOrderAmount: null,
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
    createdBy: ACTOR,
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as SupplierRow;

const baseContact = (over: Partial<SupplierContactRow> = {}): SupplierContactRow =>
  ({
    id: 'c-1',
    supplierId: SUPPLIER_ID,
    tenantId: TENANT,
    name: 'Sales Lead',
    designation: null,
    email: null,
    phone: null,
    isPrimary: false,
    notes: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as SupplierContactRow;

const stubPerformance = (): SupplierPerformance => ({
  supplierId: SUPPLIER_ID,
  totalGrns: 0,
  averageDeliveryDays: 0,
  avgExpiryRemainingDays: 0,
  shortShelfLifeIncidents: 0,
  qualityScore: 75,
  reliabilityScore: 50,
  lastDeliveryDate: null,
  totalAmountDelivered: 0,
});

const buildSvc = (
  overrides: {
    existing?: SupplierRow | null;
    byCode?: SupplierRow | null;
    byGst?: SupplierRow | null;
    contacts?: SupplierContactRow[];
  } = {},
) => {
  const suppliersRepo = {
    findByIdInTenant: jest.fn(async () => overrides.existing ?? null),
    findByCodeInTenant: jest.fn(async () => overrides.byCode ?? null),
    findByGstInTenant: jest.fn(async () => overrides.byGst ?? null),
    bulkCreate: jest.fn(async (rows: Array<Partial<SupplierRow>>) => [
      baseSupplier({ ...rows[0], id: 'created' }),
    ]),
    update: jest.fn(async (id: string, data: Partial<SupplierRow>) =>
      baseSupplier({ ...(overrides.existing ?? {}), ...data, id }),
    ),
    softDelete: jest.fn(async () => undefined),
    listPaginated: jest.fn(async () => ({
      data: [],
      nextCursor: null,
      hasMore: false,
    })),
    search: jest.fn(async () => []),
    listAllForExport: jest.fn(async () => []),
    refreshPerformanceCounters: jest.fn(async () => undefined),
    countByStatus: jest.fn(async () => ({
      active: 0,
      inactive: 0,
      blacklisted: 0,
      pending: 0,
    })),
  } as unknown as SuppliersRepository;

  const contactsRepo = {
    listForSupplier: jest.fn(async () => overrides.contacts ?? []),
    findByIdInTenant: jest.fn(async () => null),
    bulkCreate: jest.fn(async (rows: Array<Partial<SupplierContactRow>>) =>
      rows.map((r) => baseContact(r)),
    ),
    softDelete: jest.fn(async () => undefined),
    unsetPrimaryForSupplier: jest.fn(async () => undefined),
  } as unknown as SupplierContactsRepository;

  const performance = {
    getPerformance: jest.fn(async () => stubPerformance()),
  } as unknown as SupplierPerformanceService;

  const importer = {
    processBuffer: jest.fn(async () => ({
      totalRows: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    })),
  } as unknown as SupplierImportService;

  const svc = new SuppliersService(
    dbThatRunsCallback(),
    suppliersRepo,
    contactsRepo,
    performance,
    importer,
    buildAudit(),
    buildLogger(),
  );

  return { svc, suppliersRepo, contactsRepo, performance, importer };
};

describe('SuppliersService.create', () => {
  it('creates a supplier with an auto-generated code when omitted', async () => {
    const { svc, suppliersRepo } = buildSvc();
    const dto: CreateSupplierDto = {
      name: 'Acme Distributors',
      country: 'IN',
    } as CreateSupplierDto;
    const out = await svc.create(TENANT, ACTOR, dto);
    expect(out.id).toBe('created');
    const inserted = (suppliersRepo.bulkCreate as jest.Mock).mock.calls[0][0][0];
    expect(inserted.code).toMatch(/^SUP-/);
    expect(inserted.tenantId).toBe(TENANT);
    expect(inserted.status).toBe('active');
  });

  it('rejects when supplier code already exists in tenant', async () => {
    const { svc } = buildSvc({ byCode: baseSupplier({ code: 'TAKEN' }) });
    await expect(
      svc.create(TENANT, ACTOR, {
        name: 'X',
        code: 'TAKEN',
        country: 'IN',
      } as CreateSupplierDto),
    ).rejects.toBeInstanceOf(DomainConflictException);
  });

  it('rejects when GST already used by another supplier in tenant', async () => {
    const { svc } = buildSvc({
      byGst: baseSupplier({ gstNumber: '27AAPFU0939F1ZV' }),
    });
    await expect(
      svc.create(TENANT, ACTOR, {
        name: 'X',
        gstNumber: '27AAPFU0939F1ZV',
        country: 'IN',
      } as CreateSupplierDto),
    ).rejects.toBeInstanceOf(DomainConflictException);
  });

  it('seeds initial contacts and demotes all-but-first primary', async () => {
    const { svc, contactsRepo } = buildSvc();
    await svc.create(TENANT, ACTOR, {
      name: 'X',
      country: 'IN',
      contacts: [
        { name: 'A', isPrimary: true },
        { name: 'B', isPrimary: true },
      ],
    } as CreateSupplierDto);
    const insertedContacts = (contactsRepo.bulkCreate as jest.Mock).mock.calls[0][0];
    expect(insertedContacts).toHaveLength(2);
    expect(insertedContacts[0].isPrimary).toBe(true);
    expect(insertedContacts[1].isPrimary).toBe(false);
  });
});

describe('SuppliersService.findById', () => {
  it('throws when supplier missing', async () => {
    const { svc } = buildSvc();
    await expect(svc.findById(TENANT, SUPPLIER_ID)).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('returns supplier with contacts and performance attached', async () => {
    const { svc } = buildSvc({
      existing: baseSupplier(),
      contacts: [baseContact()],
    });
    const result = await svc.findById(TENANT, SUPPLIER_ID);
    expect(result.contacts).toHaveLength(1);
    expect(result.performance).toBeDefined();
    expect(result.performance.qualityScore).toBe(75);
  });
});

describe('SuppliersService.update', () => {
  it('throws when supplier missing', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.update(TENANT, ACTOR, SUPPLIER_ID, { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('rejects malformed GST without hitting the repo update', async () => {
    const { svc, suppliersRepo } = buildSvc({ existing: baseSupplier() });
    await expect(
      svc.update(TENANT, ACTOR, SUPPLIER_ID, { gstNumber: 'BAD' }),
    ).rejects.toBeInstanceOf(Error);
    expect(suppliersRepo.update as jest.Mock).not.toHaveBeenCalled();
  });

  it('rejects GST clash with another supplier', async () => {
    const { svc } = buildSvc({
      existing: baseSupplier({ gstNumber: 'OLDGST' }),
      byGst: baseSupplier({ id: 'other', gstNumber: '27AAPFU0939F1ZV' }),
    });
    await expect(
      svc.update(TENANT, ACTOR, SUPPLIER_ID, {
        gstNumber: '27AAPFU0939F1ZV',
      }),
    ).rejects.toBeInstanceOf(DomainConflictException);
  });
});

describe('SuppliersService status transitions', () => {
  it('blacklists with a reason and stamps blacklistedAt', async () => {
    const { svc, suppliersRepo } = buildSvc({ existing: baseSupplier() });
    await svc.blacklist(TENANT, ACTOR, SUPPLIER_ID, 'fraud');
    const payload = (suppliersRepo.update as jest.Mock).mock.calls[0][1];
    expect(payload.status).toBe('blacklisted');
    expect(payload.blacklistReason).toBe('fraud');
    expect(payload.blacklistedAt).toBeInstanceOf(Date);
  });

  it('allows pending → inactive', async () => {
    const { svc } = buildSvc({ existing: baseSupplier({ status: 'pending' }) });
    const updated = await svc.deactivate(TENANT, ACTOR, SUPPLIER_ID);
    expect(updated.status).toBe('inactive');
  });

  it('rejects illegal blacklisted → inactive transition', async () => {
    const { svc } = buildSvc({ existing: baseSupplier({ status: 'blacklisted' }) });
    await expect(svc.deactivate(TENANT, ACTOR, SUPPLIER_ID)).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('clears blacklist fields on activate (admin override path)', async () => {
    const { svc, suppliersRepo } = buildSvc({
      existing: baseSupplier({ status: 'blacklisted', blacklistReason: 'old' }),
    });
    await svc.activate(TENANT, ACTOR, SUPPLIER_ID);
    const payload = (suppliersRepo.update as jest.Mock).mock.calls[0][1];
    expect(payload.status).toBe('active');
    expect(payload.blacklistReason).toBeNull();
    expect(payload.blacklistedAt).toBeNull();
  });

  it('is idempotent when current status equals target', async () => {
    const { svc, suppliersRepo } = buildSvc({
      existing: baseSupplier({ status: 'active' }),
    });
    await svc.activate(TENANT, ACTOR, SUPPLIER_ID);
    expect(suppliersRepo.update as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('SuppliersService.addContact', () => {
  it('demotes other primary contacts when isPrimary=true', async () => {
    const { svc, contactsRepo } = buildSvc({ existing: baseSupplier() });
    await svc.addContact(TENANT, ACTOR, SUPPLIER_ID, {
      name: 'New Boss',
      isPrimary: true,
    });
    expect(contactsRepo.unsetPrimaryForSupplier as jest.Mock).toHaveBeenCalledWith(
      SUPPLIER_ID,
      undefined,
      expect.any(Object),
    );
  });

  it('does not touch other primaries when isPrimary=false', async () => {
    const { svc, contactsRepo } = buildSvc({ existing: baseSupplier() });
    await svc.addContact(TENANT, ACTOR, SUPPLIER_ID, {
      name: 'Junior',
      isPrimary: false,
    });
    expect(contactsRepo.unsetPrimaryForSupplier as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('SuppliersService.softDelete', () => {
  it('throws when supplier missing', async () => {
    const { svc } = buildSvc();
    await expect(svc.softDelete(TENANT, ACTOR, SUPPLIER_ID)).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('soft-deletes through the repo', async () => {
    const { svc, suppliersRepo } = buildSvc({ existing: baseSupplier() });
    await svc.softDelete(TENANT, ACTOR, SUPPLIER_ID);
    expect(suppliersRepo.softDelete as jest.Mock).toHaveBeenCalledWith(SUPPLIER_ID, ACTOR);
  });
});
