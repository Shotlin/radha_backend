import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { RecallAlertRow, RecallFeedEntryRow } from '@/db/schema/recall';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { RecallAlertsRepository } from '../repositories/recall-alerts.repository';
import { RecallService } from '../services/recall.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  }) as unknown as LoggerService;

const buildAuditLog = (): AuditLogService =>
  ({
    logAction: jest.fn().mockResolvedValue(undefined),
    logBatch: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  }) as unknown as AuditLogService;

const alertRow = (overrides: Partial<RecallAlertRow> = {}): RecallAlertRow =>
  ({
    id: 'a1',
    tenantId: 't1',
    userId: 'u1',
    savedProductId: 'sp1',
    recallFeedEntryId: 'e1',
    acknowledgedAt: null,
    createdAt: new Date('2025-01-15T00:00:00Z'),
    ...overrides,
  }) as RecallAlertRow;

const feedRow = (overrides: Partial<RecallFeedEntryRow> = {}): RecallFeedEntryRow =>
  ({
    id: 'e1',
    source: 'fssai',
    ean: '111',
    brand: 'B',
    productName: 'P',
    batchNumber: 'B-1',
    reason: 'Recalled',
    recalledAt: '2025-01-14' as unknown as RecallFeedEntryRow['recalledAt'],
    raw: {},
    fetchedAt: new Date(),
    ...overrides,
  }) as RecallFeedEntryRow;

describe('RecallService', () => {
  describe('listAlerts', () => {
    it('returns empty data when repo has no rows', async () => {
      const repo = {
        listForUser: jest.fn().mockResolvedValue([]),
      } as unknown as RecallAlertsRepository;
      const svc = new RecallService(repo, buildLogger(), buildAuditLog());

      const result = await svc.listAlerts('u1', 't1', { limit: 50 });
      expect(result.data).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('shapes rows into the API response and exposes nextCursor when over limit', async () => {
      const rows = Array.from({ length: 6 }).map((_, i) => ({
        alert: alertRow({
          id: `a${i + 1}`,
          createdAt: new Date(2025, 0, 10 - i),
        }),
        feedEntry: feedRow({ id: `e${i + 1}`, productName: `P${i + 1}` }),
      }));
      const repo = {
        listForUser: jest.fn().mockResolvedValue(rows),
      } as unknown as RecallAlertsRepository;
      const svc = new RecallService(repo, buildLogger(), buildAuditLog());

      const result = await svc.listAlerts('u1', 't1', { limit: 5 });
      expect(result.data).toHaveLength(5);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toEqual(expect.any(String));
      expect(result.data[0].feedEntry.productName).toBe('P1');
    });

    it('passes unacknowledgedOnly through to the repo', async () => {
      const repo = {
        listForUser: jest.fn().mockResolvedValue([]),
      } as unknown as RecallAlertsRepository;
      const svc = new RecallService(repo, buildLogger(), buildAuditLog());

      await svc.listAlerts('u1', 't1', { limit: 10, unacknowledgedOnly: true });
      expect(repo.listForUser).toHaveBeenCalledWith(
        'u1',
        't1',
        expect.objectContaining({ unacknowledgedOnly: true, limit: 10 }),
      );
    });
  });

  describe('acknowledge', () => {
    it('marks an alert as acknowledged for the owner', async () => {
      const existing = alertRow();
      const updated = alertRow({ acknowledgedAt: new Date('2025-01-20T10:00:00Z') });
      const repo = {
        findByIdForUser: jest.fn().mockResolvedValue(existing),
        acknowledge: jest.fn().mockResolvedValue(updated),
      } as unknown as RecallAlertsRepository;
      const audit = buildAuditLog();
      const svc = new RecallService(repo, buildLogger(), audit);

      const result = await svc.acknowledge('u1', 't1', 'a1');
      expect(result.id).toBe('a1');
      expect(result.acknowledgedAt).toEqual(expect.any(String));
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'recall_alert',
          resourceId: 'a1',
        }),
      );
    });

    it('returns the existing acknowledgedAt when already acknowledged (idempotent)', async () => {
      const acked = new Date('2025-01-20T10:00:00Z');
      const existing = alertRow({ acknowledgedAt: acked });
      const repo = {
        findByIdForUser: jest.fn().mockResolvedValue(existing),
        acknowledge: jest.fn(),
      } as unknown as RecallAlertsRepository;
      const svc = new RecallService(repo, buildLogger(), buildAuditLog());

      const result = await svc.acknowledge('u1', 't1', 'a1');
      expect(result.acknowledgedAt).toBe(acked.toISOString());
      expect(repo.acknowledge).not.toHaveBeenCalled();
    });

    it('throws NotFound when the alert is not owned by the user', async () => {
      const repo = {
        findByIdForUser: jest.fn().mockResolvedValue(null),
        acknowledge: jest.fn(),
      } as unknown as RecallAlertsRepository;
      const svc = new RecallService(repo, buildLogger(), buildAuditLog());

      await expect(svc.acknowledge('u1', 't1', 'a1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Forbidden when the tenant does not match (defence-in-depth)', async () => {
      const existing = alertRow({ tenantId: 't-other' });
      const repo = {
        findByIdForUser: jest.fn().mockResolvedValue(existing),
        acknowledge: jest.fn(),
      } as unknown as RecallAlertsRepository;
      const svc = new RecallService(repo, buildLogger(), buildAuditLog());

      await expect(svc.acknowledge('u1', 't1', 'a1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
