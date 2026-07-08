import { DbService } from '@/db/db.service';

import { AuditTrailGenerator } from '../generators/audit-trail.generator';
import { DashboardSummaryGenerator } from '../generators/dashboard-summary.generator';
import { EanMismatchGenerator } from '../generators/ean-mismatch.generator';
import { ExpirySummaryGenerator } from '../generators/expiry-summary.generator';
import { GrnHistoryGenerator } from '../generators/grn-history.generator';
import { HealthDistributionGenerator } from '../generators/health-distribution.generator';
import { InventorySummaryGenerator } from '../generators/inventory-summary.generator';
import { ScanHistoryGenerator } from '../generators/scan-history.generator';
import { TaskCompletionGenerator } from '../generators/task-completion.generator';
import { DailyStoreMetricsRepository } from '../repositories/daily-store-metrics.repository';
import type { GenerateReportParams } from '../types/report.types';

const TENANT = 'tenant-1';

const params: GenerateReportParams = {
  type: 'expiry-summary',
  formats: ['json'],
  storeIds: ['store-1'],
  dateRange: {
    from: new Date('2026-04-01T00:00:00Z'),
    to: new Date('2026-04-30T00:00:00Z'),
  },
};

/**
 * Build a DbService whose `getDb().execute()` returns a queued
 * sequence of canned results. Each call shifts the queue; once
 * exhausted we return `{ rows: [] }` so generators with conditional
 * follow-up reads don't crash.
 */
const buildDb = (results: Array<{ rows: unknown[] }>): DbService => {
  const queue = [...results];
  const execute = jest.fn(async () => queue.shift() ?? { rows: [] });
  return {
    getDb: () => ({ execute }),
  } as unknown as DbService;
};

describe('ExpirySummaryGenerator', () => {
  it('aggregates per-status counts into the summary block', async () => {
    const db = buildDb([
      {
        rows: [
          { status: 'green', count: 10, total_quantity: 50 },
          { status: 'yellow', count: 4, total_quantity: 8 },
          { status: 'red', count: 2, total_quantity: 4 },
        ],
      },
      {
        rows: [
          {
            expiry_record_id: 'er-1',
            product_id: 'p-1',
            product_name: 'Tea',
            brand: 'Acme',
            ean: '0123456789012',
            category: 'beverages',
            store_id: 'store-1',
            store_name: 'Shop 1',
            expiry_date: new Date('2026-05-01T00:00:00Z'),
            days_remaining: 12,
            status: 'yellow',
            quantity: 5,
            remaining_quantity: 5,
            batch_number: null,
          },
        ],
      },
    ]);
    const gen = new ExpirySummaryGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect(out.summary).toEqual(
      expect.objectContaining({ green: 10, yellow: 4, red: 2, total: 16, totalQuantity: 62 }),
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.productName).toBe('Tea');
  });

  it('handles empty result sets gracefully', async () => {
    const db = buildDb([{ rows: [] }, { rows: [] }]);
    const gen = new ExpirySummaryGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect(out.summary).toEqual(expect.objectContaining({ total: 0, green: 0, yellow: 0, red: 0 }));
    expect(out.rows).toHaveLength(0);
  });
});

describe('EanMismatchGenerator', () => {
  it('computes match-rate and projects rows', async () => {
    const db = buildDb([
      {
        rows: [
          { status: 'matched', count: 90 },
          { status: 'unmatched', count: 10 },
        ],
      },
      {
        rows: [
          {
            scan_item_id: 'si-1',
            session_id: 'ses-1',
            store_id: 'store-1',
            store_name: 'Shop 1',
            user_id: 'u-1',
            user_name: 'Asha',
            ean: '0123456789012',
            product_id: null,
            product_name: 'Unknown',
            scanned_at: new Date(),
            match_status: 'unmatched',
            ean_list_id: null,
          },
        ],
      },
    ]);
    const gen = new EanMismatchGenerator(db);
    const out = await gen.generate(params, TENANT);
    const summary = out.summary as Record<string, number>;
    expect(summary.matched).toBe(90);
    expect(summary.unmatched).toBe(10);
    expect(summary.matchRate).toBe(90);
    expect(out.rows).toHaveLength(1);
  });

  it('returns matchRate=0 with no scans', async () => {
    const db = buildDb([{ rows: [] }, { rows: [] }]);
    const gen = new EanMismatchGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect((out.summary as Record<string, number>).matchRate).toBe(0);
  });
});

describe('ScanHistoryGenerator', () => {
  it('returns aggregate totals + per-row data', async () => {
    const db = buildDb([
      { rows: [{ total: 5, sessions: 2, unique_users: 2, unique_eans: 4 }] },
      {
        rows: [
          {
            scan_item_id: 'si-1',
            session_id: 'ses-1',
            store_id: 'store-1',
            store_name: 'Shop 1',
            user_id: 'u-1',
            user_name: 'Asha',
            ean: '0123456789012',
            product_id: 'p-1',
            product_name: 'Tea',
            match_status: 'matched',
            expiry_status: 'green',
            scanned_at: new Date(),
          },
        ],
      },
    ]);
    const gen = new ScanHistoryGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect(out.summary).toEqual({
      totalScans: 5,
      sessions: 2,
      uniqueUsers: 2,
      uniqueEans: 4,
    });
    expect(out.rows).toHaveLength(1);
  });
});

describe('TaskCompletionGenerator', () => {
  it('returns a deferral note when the tasks table is missing', async () => {
    const db = buildDb([{ rows: [{ exists: false }] }]);
    const gen = new TaskCompletionGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect((out.summary as Record<string, unknown>).notes).toMatch(/BE-19/);
    expect(out.meta?.deferred).toBe('BE-19');
  });

  it('returns full data when the tasks table exists', async () => {
    const db = buildDb([
      { rows: [{ exists: true }] },
      {
        rows: [
          { status: 'completed', count: 4 },
          { status: 'pending', count: 2 },
          { status: 'overdue', count: 1 },
        ],
      },
      {
        rows: [
          {
            task_id: 't-1',
            title: 'Stock check',
            status: 'completed',
            assigned_to: 'u-1',
            assigned_by: 'u-2',
            store_id: 'store-1',
            created_at: new Date(),
            due_at: null,
            completed_at: new Date(),
            duration_minutes: 30,
          },
        ],
      },
    ]);
    const gen = new TaskCompletionGenerator(db);
    const out = await gen.generate(params, TENANT);
    const summary = out.summary as Record<string, number>;
    expect(summary.completed).toBe(4);
    expect(summary.completionRate).toBeGreaterThan(0);
    expect(out.rows).toHaveLength(1);
  });
});

describe('AuditTrailGenerator', () => {
  it('aggregates by action and projects rows', async () => {
    const db = buildDb([
      {
        rows: [
          { action: 'CREATE', count: 12 },
          { action: 'UPDATE', count: 7 },
        ],
      },
      {
        rows: [
          {
            audit_log_id: 'al-1',
            action: 'CREATE',
            resource_type: 'Product',
            resource_id: 'p-1',
            user_id: 'u-1',
            occurred_at: new Date(),
            success: true,
            error_code: null,
          },
        ],
      },
    ]);
    const gen = new AuditTrailGenerator(db);
    const out = await gen.generate(params, TENANT);
    const summary = out.summary as { total: number; byAction: Record<string, number> };
    expect(summary.total).toBe(19);
    expect(summary.byAction.CREATE).toBe(12);
    expect(out.rows).toHaveLength(1);
  });
});

describe('HealthDistributionGenerator', () => {
  it('aggregates grade / status / child-safety distributions', async () => {
    const db = buildDb([
      {
        rows: [
          { grade: 'A', status: 'green', child_safety: 'suitable', count: 10 },
          { grade: 'C', status: 'yellow', child_safety: 'caution', count: 5 },
        ],
      },
    ]);
    const gen = new HealthDistributionGenerator(db);
    const out = await gen.generate(params, TENANT);
    const summary = out.summary as {
      total: number;
      byGrade: Record<string, number>;
      byChildSafety: Record<string, number>;
    };
    expect(summary.total).toBe(15);
    expect(summary.byGrade.A).toBe(10);
    expect(summary.byChildSafety.caution).toBe(5);
    expect(out.rows).toHaveLength(2);
  });
});

describe('InventorySummaryGenerator', () => {
  it('returns a deferral note when inventory table is missing', async () => {
    const db = buildDb([{ rows: [{ exists: false }] }]);
    const gen = new InventorySummaryGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect(out.meta?.deferred).toBe('BE-27');
  });

  it('aggregates levels when the table exists', async () => {
    const db = buildDb([
      { rows: [{ exists: true }] },
      { rows: [{ total: 100, in_stock: 80, low_stock: 15, out_of_stock: 5 }] },
    ]);
    const gen = new InventorySummaryGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect(out.summary).toEqual({
      total: 100,
      inStock: 80,
      lowStock: 15,
      outOfStock: 5,
    });
  });
});

describe('GrnHistoryGenerator', () => {
  it('returns a deferral note when GRN tables missing', async () => {
    const db = buildDb([{ rows: [{ exists: false }] }]);
    const gen = new GrnHistoryGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect(out.meta?.deferred).toBe('BE-26');
  });

  it('summarises per-status when GRN headers present', async () => {
    const db = buildDb([
      { rows: [{ exists: true }] },
      {
        rows: [
          { status: 'posted', count: 8 },
          { status: 'pending', count: 2 },
        ],
      },
    ]);
    const gen = new GrnHistoryGenerator(db);
    const out = await gen.generate(params, TENANT);
    expect(out.summary).toEqual(expect.objectContaining({ total: 10, posted: 8, pending: 2 }));
  });
});

describe('DashboardSummaryGenerator', () => {
  it('rejects when storeIds is missing or has multiple ids', async () => {
    const gen = new DashboardSummaryGenerator(
      buildDb([]),
      {} as unknown as DailyStoreMetricsRepository,
    );
    await expect(gen.generate({ ...params, storeIds: [] }, TENANT)).rejects.toThrow();
    await expect(gen.generate({ ...params, storeIds: ['a', 'b'] }, TENANT)).rejects.toThrow();
  });

  it('summarise() runs six queries in parallel and assembles totals', async () => {
    const db = buildDb([
      // getScanStats — scans
      { rows: [{ total: 100, matched: 80, unmatched: 20 }] },
      // getScanStats — sessions
      { rows: [{ completed: 4 }] },
      // getExpiryStats — status
      { rows: [{ status: 'green', count: 30 }] },
      // getExpiryStats — alerts
      { rows: [{ active: 2 }] },
      // getTaskStats — table-exists probe
      { rows: [{ exists: false }] },
      // getTopProducts
      {
        rows: [{ product_id: 'p-1', product_name: 'Tea', scan_count: 12 }],
      },
      // getTopUsers
      {
        rows: [{ user_id: 'u-1', user_name: 'Asha', scan_count: 9 }],
      },
    ]);
    const metricsRepo = {
      getTrendPoints: jest.fn(async () => [
        { date: '2026-04-10', scans: 10, expiryAdded: 1, tasksCompleted: 0 },
      ]),
    } as unknown as DailyStoreMetricsRepository;

    const gen = new DashboardSummaryGenerator(db, metricsRepo);
    const out = await gen.summarise(TENANT, 'store-1', params.dateRange);
    expect(out.totals.scans).toBe(100);
    expect(out.totals.sessionsCompleted).toBe(4);
    expect(out.scanHealth.matchRate).toBe(80);
    expect(out.expiry.green).toBe(30);
    expect(out.totals.activeAlerts).toBe(2);
    expect(out.trends).toHaveLength(1);
    expect(out.topProducts[0]!.productName).toBe('Tea');
  });

  it('falls back to matchRate=0 when no scans were captured', async () => {
    const db = buildDb([
      { rows: [{ total: 0, matched: 0, unmatched: 0 }] },
      { rows: [{ completed: 0 }] },
      { rows: [] },
      { rows: [{ active: 0 }] },
      { rows: [{ exists: false }] },
      { rows: [] },
      { rows: [] },
    ]);
    const metricsRepo = {
      getTrendPoints: jest.fn(async () => []),
    } as unknown as DailyStoreMetricsRepository;
    const gen = new DashboardSummaryGenerator(db, metricsRepo);
    const out = await gen.summarise(TENANT, 'store-1', params.dateRange);
    expect(out.scanHealth.matchRate).toBe(0);
    expect(out.totals.scans).toBe(0);
  });
});
