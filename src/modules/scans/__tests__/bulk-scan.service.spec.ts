import {
  BusinessException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { ScanItemRow, ScanSessionRow, ScanSyncBatchRow } from '@/db/schema/scans';

import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { ScanSessionsRepository } from '../repositories/scan-sessions.repository';
import { ScanSyncBatchesRepository } from '../repositories/scan-sync-batches.repository';
import { BulkScanService } from '../services/bulk-scan.service';
import { IdempotencyService } from '../services/idempotency.service';
import { ScanItemService } from '../services/scan-item.service';

const TENANT = 'tenant-1';
const STORE = 'store-1';
const USER = 'user-1';
const SESSION = 'session-1';

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

const baseSession = (over: Partial<ScanSessionRow> = {}): ScanSessionRow =>
  ({
    id: SESSION,
    tenantId: TENANT,
    storeId: STORE,
    userId: USER,
    status: 'active',
    type: 'audit',
    ...over,
  }) as unknown as ScanSessionRow;

const baseBatch = (over: Partial<ScanSyncBatchRow> = {}): ScanSyncBatchRow =>
  ({
    id: 'batch-1',
    tenantId: TENANT,
    sessionId: SESSION,
    userId: USER,
    status: 'queued',
    totalItems: over.totalItems ?? 0,
    processedItems: 0,
    succeededItems: 0,
    failedItems: 0,
    duplicateItems: 0,
    errors: [],
    startedAt: null,
    completedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as ScanSyncBatchRow;

const sampleItem = (over: Partial<{ clientId: string; ean: string }> = {}) => ({
  clientId: over.clientId ?? '11111111-1111-1111-1111-111111111111',
  ean: over.ean ?? '8901030789885',
  scannedAt: new Date('2026-05-22T10:00:00Z'),
  quantity: 1,
});

interface BuildOpts {
  session?: ScanSessionRow | null;
  existingByClientId?: Record<string, ScanItemRow>;
  recordScanFails?: boolean;
}

const buildSvc = (opts: BuildOpts = {}) => {
  const sessionsRepo = {
    findByIdInTenant: jest.fn(async () =>
      opts.session === null ? null : (opts.session ?? baseSession()),
    ),
  } as unknown as ScanSessionsRepository;

  const itemsRepo = {} as unknown as ScanItemsRepository;

  let batch = baseBatch();
  const batchesRepo = {
    create: jest.fn(async (data: Partial<ScanSyncBatchRow>) => {
      batch = baseBatch({ ...batch, ...data });
      return batch;
    }),
    findByIdInTenant: jest.fn(async () => batch),
    update: jest.fn(async (id: string, data: Partial<ScanSyncBatchRow>) => {
      batch = { ...batch, ...data, id } as ScanSyncBatchRow;
      return batch;
    }),
    listForTenant: jest.fn(async () => [batch]),
  } as unknown as ScanSyncBatchesRepository;

  const idempotency = {
    findExisting: jest.fn(
      async (_sid: string, clientId: string) => opts.existingByClientId?.[clientId] ?? null,
    ),
    findExistingMany: jest.fn(async (_sid: string, clientIds: string[]) => {
      const map = new Map<string, ScanItemRow>();
      for (const id of clientIds) {
        const row = opts.existingByClientId?.[id];
        if (row) map.set(id, row);
      }
      return map;
    }),
  } as unknown as IdempotencyService;

  const itemService = {
    recordScan: jest.fn(async (_t: string, _u: string, _s: string, dto: { clientId?: string }) => {
      if (opts.recordScanFails) {
        throw Object.assign(new Error('boom'), { code: 'E2000' });
      }
      return {
        scanItem: {
          id: `item-${dto.clientId}`,
          sessionId: SESSION,
          clientId: dto.clientId,
        } as unknown as ScanItemRow,
        product: undefined,
        eanValidation: undefined,
        expiryStatus: 'unknown' as const,
        isDuplicate: false,
        duplicateOf: null,
        warnings: [],
      };
    }),
  } as unknown as ScanItemService;

  const svc = new BulkScanService(
    batchesRepo,
    sessionsRepo,
    itemsRepo,
    idempotency,
    itemService,
    buildLogger(),
    buildAudit(),
  );
  return { svc, batchesRepo, idempotency, itemService };
};

describe('BulkScanService.submit', () => {
  it('rejects when session is missing', async () => {
    const { svc } = buildSvc({ session: null });
    await expect(
      svc.submit(TENANT, USER, SESSION, { items: [sampleItem()] }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('rejects when caller is not the session owner', async () => {
    const { svc } = buildSvc({ session: baseSession({ userId: 'other' }) });
    await expect(
      svc.submit(TENANT, USER, SESSION, { items: [sampleItem()] }),
    ).rejects.toBeInstanceOf(DomainForbiddenException);
  });

  it('rejects when session is not active', async () => {
    const { svc } = buildSvc({ session: baseSession({ status: 'completed' }) });
    await expect(
      svc.submit(TENANT, USER, SESSION, { items: [sampleItem()] }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects when items array is empty', async () => {
    const { svc } = buildSvc();
    await expect(svc.submit(TENANT, USER, SESSION, { items: [] })).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('rejects when items array exceeds the cap', async () => {
    const { svc } = buildSvc();
    const items = Array.from({ length: 5001 }, (_, i) => sampleItem({ clientId: `cid-${i}` }));
    await expect(
      svc.submit(TENANT, USER, SESSION, { items: items as never }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects when the batch contains duplicate clientIds', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.submit(TENANT, USER, SESSION, {
        items: [
          sampleItem({ clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
          sampleItem({ clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ean: '8901491100049' }),
        ],
      }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('persists a batch row and processes items', async () => {
    const { svc, batchesRepo, itemService } = buildSvc();
    const out = await svc.submit(TENANT, USER, SESSION, {
      items: [
        sampleItem({ clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
        sampleItem({ clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', ean: '8901491100049' }),
      ],
    });
    expect(out.totalItems).toBe(2);
    expect(out.status).toBe('completed');
    expect(batchesRepo.create as jest.Mock).toHaveBeenCalled();
    expect(itemService.recordScan as jest.Mock).toHaveBeenCalledTimes(2);
  });
});

describe('BulkScanService.processBatch — idempotency + classification', () => {
  it('classifies known clientIds as duplicates and skips the recordScan call', async () => {
    const existing = {
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': {
        id: 'existing-1',
        sessionId: SESSION,
        clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      } as unknown as ScanItemRow,
    };
    const { svc, itemService } = buildSvc({ existingByClientId: existing });
    const result = await svc.processBatch('batch-1', TENANT, USER, SESSION, [
      sampleItem({ clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
      sampleItem({ clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', ean: '8901491100049' }),
    ]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.existingId).toBe('existing-1');
    expect(result.successful).toHaveLength(1);
    expect(itemService.recordScan as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('captures failures with errorCode when recordScan throws', async () => {
    const { svc } = buildSvc({ recordScanFails: true });
    const result = await svc.processBatch('batch-1', TENANT, USER, SESSION, [
      sampleItem({ clientId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    ]);
    expect(result.successful).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.errorCode).toBe('E2000');
  });
});

describe('BulkScanService.cancel', () => {
  it('throws on missing batch', async () => {
    const { svc, batchesRepo } = buildSvc();
    (batchesRepo.findByIdInTenant as jest.Mock).mockResolvedValueOnce(null);
    await expect(svc.cancel(TENANT, USER, 'batch-1')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('throws DomainForbiddenException when caller is not the owner', async () => {
    const { svc, batchesRepo } = buildSvc();
    (batchesRepo.findByIdInTenant as jest.Mock).mockResolvedValueOnce(
      baseBatch({ userId: 'other-user', status: 'processing' }),
    );
    await expect(svc.cancel(TENANT, USER, 'batch-1')).rejects.toBeInstanceOf(
      DomainForbiddenException,
    );
  });

  it('returns terminal status without writing for already-completed batches', async () => {
    const { svc, batchesRepo } = buildSvc();
    (batchesRepo.findByIdInTenant as jest.Mock).mockResolvedValueOnce(
      baseBatch({ status: 'completed', totalItems: 2, processedItems: 2 }),
    );
    const status = await svc.cancel(TENANT, USER, 'batch-1');
    expect(status.status).toBe('completed');
    expect(batchesRepo.update as jest.Mock).not.toHaveBeenCalled();
  });
});
