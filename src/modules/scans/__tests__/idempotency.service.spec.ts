import type { ScanItemRow } from '@/db/schema/scans';

import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { IdempotencyService } from '../services/idempotency.service';

const buildSvc = (
  overrides: {
    byClientId?: Record<string, ScanItemRow | null>;
  } = {},
) => {
  const findByClientId = jest.fn(
    async (_sessionId: string, clientId: string) => overrides.byClientId?.[clientId] ?? null,
  );
  const findManyByClientIds = jest.fn(async (_sessionId: string, ids: string[]) => {
    const rows: ScanItemRow[] = [];
    for (const id of ids) {
      const r = overrides.byClientId?.[id];
      if (r) rows.push(r);
    }
    return rows;
  });
  const repo = { findByClientId, findManyByClientIds } as unknown as ScanItemsRepository;
  return { svc: new IdempotencyService(repo), findByClientId, findManyByClientIds };
};

describe('IdempotencyService.findExisting', () => {
  it('returns null when nothing is cached', async () => {
    const { svc } = buildSvc();
    expect(await svc.findExisting('s-1', 'c-1')).toBeNull();
  });

  it('returns the cached row when present', async () => {
    const row = { id: 'item-1', sessionId: 's-1', clientId: 'c-1' } as unknown as ScanItemRow;
    const { svc } = buildSvc({ byClientId: { 'c-1': row } });
    expect(await svc.findExisting('s-1', 'c-1')).toBe(row);
  });
});

describe('IdempotencyService.findExistingMany', () => {
  it('returns an empty Map for an empty input', async () => {
    const { svc, findManyByClientIds } = buildSvc();
    const map = await svc.findExistingMany('s-1', []);
    expect(map.size).toBe(0);
    expect(findManyByClientIds).not.toHaveBeenCalled();
  });

  it('builds a Map keyed by clientId for matching rows', async () => {
    const r1 = { id: 'item-1', sessionId: 's-1', clientId: 'c-1' } as unknown as ScanItemRow;
    const r2 = { id: 'item-2', sessionId: 's-1', clientId: 'c-2' } as unknown as ScanItemRow;
    const { svc } = buildSvc({ byClientId: { 'c-1': r1, 'c-2': r2 } });
    const map = await svc.findExistingMany('s-1', ['c-1', 'c-2', 'c-missing']);
    expect(map.size).toBe(2);
    expect(map.get('c-1')?.id).toBe('item-1');
    expect(map.get('c-2')?.id).toBe('item-2');
    expect(map.get('c-missing')).toBeUndefined();
  });
});
