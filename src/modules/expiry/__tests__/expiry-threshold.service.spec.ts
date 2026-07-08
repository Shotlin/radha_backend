import type { ExpiryThresholdRow } from '@/db/schema/expiry';

import { ExpiryThresholdsRepository } from '../repositories/expiry-thresholds.repository';
import { ExpiryThresholdService } from '../services/expiry-threshold.service';

const buildSvc = (overrides: { tenantRow?: ExpiryThresholdRow | null } = {}) => {
  const repo = {
    findEffective: jest.fn(async () => overrides.tenantRow ?? null),
    listForTenant: jest.fn(async () => []),
    upsertForTenant: jest.fn(
      async (_t: string, _u: string, data) =>
        ({ ...data, id: 'r-1', tenantId: 't-1' }) as unknown as ExpiryThresholdRow,
    ),
  } as unknown as ExpiryThresholdsRepository;
  return { svc: new ExpiryThresholdService(repo), repo };
};

describe('ExpiryThresholdService.resolve', () => {
  it('returns a tenant-row when the repo finds one', async () => {
    const tenantRow = {
      category: 'dairy',
      yellowDays: 14,
      redDays: 3,
      tenantId: 't-1',
    } as unknown as ExpiryThresholdRow;
    const { svc } = buildSvc({ tenantRow });
    const result = await svc.resolve('dairy', 't-1');
    expect(result).toMatchObject({
      category: 'dairy',
      yellowDays: 14,
      redDays: 3,
      isPlatformDefault: false,
      tenantId: 't-1',
    });
  });

  it('falls back to platform default when no DB row exists', async () => {
    const { svc } = buildSvc();
    const result = await svc.resolve('dairy', 't-1');
    expect(result.isPlatformDefault).toBe(true);
    expect(result.yellowDays).toBe(7);
    expect(result.redDays).toBe(2);
  });

  it('falls back to "other" defaults for unknown category', async () => {
    const { svc } = buildSvc();
    const result = await svc.resolve('unknown-category', 't-1');
    expect(result.category).toBe('other');
    expect(result.yellowDays).toBe(30);
    expect(result.redDays).toBe(7);
  });

  it('returns "other" defaults when category is null', async () => {
    const { svc } = buildSvc();
    const result = await svc.resolve(null, 't-1');
    expect(result.category).toBe('other');
  });
});

describe('ExpiryThresholdService.upsertForTenant', () => {
  it('lower-cases the category before persisting', async () => {
    const { svc, repo } = buildSvc();
    await svc.upsertForTenant('t-1', 'u-1', {
      category: 'DAIRY',
      yellowDays: 10,
      redDays: 3,
    });
    const call = (repo.upsertForTenant as jest.Mock).mock.calls[0]![2];
    expect(call.category).toBe('dairy');
  });
});
