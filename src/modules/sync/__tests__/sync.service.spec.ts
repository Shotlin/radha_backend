import { Test, TestingModule } from '@nestjs/testing';

import {
  SERVER_WINS_FIELDS,
  SyncService,
  type SyncContext,
} from '../services/sync.service';
import type { SyncBatchDto } from '../dto/sync-batch.dto';

/**
 * BE-44 — `SyncService` unit tests.
 *
 * Covers the orchestrator-level guarantees the bulk sync contract
 * promises today:
 *   - per-item processed/failed map (partial failure tolerated),
 *   - intra-batch dedup of repeated idempotency keys,
 *   - last-write-wins by Lamport timestamp on the same logical id,
 *   - server-wins stripping of security-sensitive fields,
 *   - empty-result `getChanges` shape.
 */
describe('SyncService', () => {
  let service: SyncService;

  const baseContext: SyncContext = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    resource: 'scans',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SyncService],
    }).compile();

    service = module.get(SyncService);
  });

  describe('processBatch', () => {
    it('returns processed entries for a happy-path batch', async () => {
      const batch: SyncBatchDto = {
        items: [
          {
            idempotencyKey: 'idem-key-aaaaaaaa',
            payload: { id: 'scan-1', barcode: '1234567890' },
          },
          {
            idempotencyKey: 'idem-key-bbbbbbbb',
            payload: { id: 'scan-2', barcode: '0987654321' },
          },
        ],
      };

      const result = await service.processBatch(batch, baseContext);

      expect(result.total).toBe(2);
      expect(result.failed).toEqual([]);
      expect(result.processed).toHaveLength(2);
      expect(result.processed[0]).toMatchObject({
        index: 0,
        idempotencyKey: 'idem-key-aaaaaaaa',
        status: 'created',
        id: 'scan-1',
      });
    });

    it('collapses duplicate idempotency keys within the batch as noop', async () => {
      const batch: SyncBatchDto = {
        items: [
          {
            idempotencyKey: 'idem-key-dup-aaaa',
            payload: { id: 'scan-1' },
          },
          {
            idempotencyKey: 'idem-key-dup-aaaa',
            payload: { id: 'scan-1' },
          },
        ],
      };

      const result = await service.processBatch(batch, baseContext);

      expect(result.processed).toHaveLength(2);
      expect(result.processed[0].status).toBe('created');
      expect(result.processed[1].status).toBe('noop');
      expect(result.failed).toEqual([]);
    });

    it('applies last-write-wins by Lamport timestamp for the same id', async () => {
      const batch: SyncBatchDto = {
        items: [
          {
            idempotencyKey: 'idem-key-newer-aa',
            lamportTimestamp: { counter: 50, nodeId: 'phone' },
            payload: { id: 'scan-conflict', barcode: 'NEW' },
          },
          {
            idempotencyKey: 'idem-key-older-bb',
            lamportTimestamp: { counter: 10, nodeId: 'phone' },
            payload: { id: 'scan-conflict', barcode: 'OLD' },
          },
        ],
      };

      const result = await service.processBatch(batch, baseContext);

      // Newer item is processed normally; older one is dropped as noop
      // because it lost the Lamport comparison against the high-water
      // mark set by item[0].
      expect(result.processed[0].status).toBe('created');
      expect(result.processed[1].status).toBe('noop');
      expect(result.processed[1].id).toBe('scan-conflict');
    });

    it('records per-item errors without failing the whole batch', async () => {
      const batch: SyncBatchDto = {
        items: [
          {
            idempotencyKey: 'idem-key-good-aa',
            payload: { id: 'scan-good' },
          },
          {
            idempotencyKey: 'idem-key-bad-bbb',
            payload: { id: 'scan-bad' },
          },
        ],
      };

      // Force the second item to throw by stubbing the dispatcher.
      const dispatchSpy = jest
        .spyOn(service as unknown as { dispatch: jest.Mock }, 'dispatch')
        .mockResolvedValueOnce({ status: 'created', id: 'scan-good' })
        .mockRejectedValueOnce(new Error('downstream blew up'));

      const result = await service.processBatch(batch, baseContext);

      expect(dispatchSpy).toHaveBeenCalledTimes(2);
      expect(result.processed).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        index: 1,
        idempotencyKey: 'idem-key-bad-bbb',
        error: { code: 'SYNC_ITEM_FAILED', message: 'downstream blew up' },
      });
    });

    it('strips server-wins fields from incoming payloads', async () => {
      const dispatchSpy = jest
        .spyOn(service as unknown as { dispatch: jest.Mock }, 'dispatch')
        .mockResolvedValue({ status: 'created' });

      const batch: SyncBatchDto = {
        items: [
          {
            idempotencyKey: 'idem-key-strip-aa',
            payload: {
              id: 'item-1',
              tier: 'premium_consumer',
              role: 'admin',
              email_verified: true,
              subscription: {
                tier: 'pro',
                status: 'active',
                renewsAt: '2025-01-01T00:00:00Z',
              },
              user: { role: 'owner', email_verified: true, name: 'Asha' },
            },
          },
        ],
      };

      await service.processBatch(batch, baseContext);

      const sanitisedItem = dispatchSpy.mock.calls[0][1] as { payload: Record<string, unknown> };
      const payload = sanitisedItem.payload;

      // Top-level dangerous fields are removed.
      for (const field of SERVER_WINS_FIELDS.subscriptions) {
        expect(payload).not.toHaveProperty(field);
      }
      for (const field of SERVER_WINS_FIELDS.users) {
        expect(payload).not.toHaveProperty(field);
      }

      // Nested dangerous fields are removed but harmless ones survive.
      const subscription = payload.subscription as Record<string, unknown>;
      expect(subscription).not.toHaveProperty('tier');
      expect(subscription).not.toHaveProperty('status');
      expect(subscription.renewsAt).toBe('2025-01-01T00:00:00Z');

      const user = payload.user as Record<string, unknown>;
      expect(user).not.toHaveProperty('role');
      expect(user).not.toHaveProperty('email_verified');
      expect(user.name).toBe('Asha');

      // The id passes through untouched.
      expect(payload.id).toBe('item-1');
    });

    it('reports total = items.length even when all fail', async () => {
      jest
        .spyOn(service as unknown as { dispatch: jest.Mock }, 'dispatch')
        .mockRejectedValue(new Error('boom'));

      const batch: SyncBatchDto = {
        items: [
          { idempotencyKey: 'idem-fail-aaaa', payload: { id: 'a' } },
          { idempotencyKey: 'idem-fail-bbbb', payload: { id: 'b' } },
        ],
      };

      const result = await service.processBatch(batch, baseContext);
      expect(result.total).toBe(2);
      expect(result.processed).toEqual([]);
      expect(result.failed).toHaveLength(2);
    });

    it('routes by resource (saved-products and allergen-profiles dispatch cleanly)', async () => {
      const batch: SyncBatchDto = {
        items: [{ idempotencyKey: 'idem-key-route-aa', payload: { id: 'x-1' } }],
      };

      const savedResult = await service.processBatch(batch, {
        ...baseContext,
        resource: 'saved-products',
      });
      const allergenResult = await service.processBatch(batch, {
        ...baseContext,
        resource: 'allergen-profiles',
      });

      expect(savedResult.processed[0].status).toBe('created');
      expect(allergenResult.processed[0].status).toBe('created');
    });
  });

  describe('getChanges', () => {
    it('returns an empty changes envelope with a serverTime stamp', async () => {
      const before = Date.now();
      const result = await service.getChanges(
        { tenantId: 'tenant-1', userId: 'user-1' },
        { since: '2024-01-01T00:00:00Z' },
      );
      const after = Date.now();

      expect(result.changes).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(typeof result.serverTime).toBe('string');

      const parsed = Date.parse(result.serverTime);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(after + 5);
    });

    it('handles missing query params without throwing', async () => {
      await expect(
        service.getChanges({ tenantId: null, userId: 'user-1' }, {}),
      ).resolves.toMatchObject({ changes: [], nextCursor: null });
    });
  });
});
