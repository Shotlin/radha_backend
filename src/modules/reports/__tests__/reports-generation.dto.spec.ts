import { randomUUID } from 'crypto';

import {
  AggregateMetricsBodySchema,
  DashboardQuerySchema,
  GenerateReportSchema,
  ListReportsQuerySchema,
  ScheduleReportSchema,
} from '../dto/reports.dto';

describe('GenerateReportSchema', () => {
  const base = {
    type: 'expiry-summary' as const,
    formats: ['xlsx'] as const,
    dateRange: {
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    },
  };

  it('accepts a minimal valid payload', () => {
    const parsed = GenerateReportSchema.parse(base);
    expect(parsed.type).toBe('expiry-summary');
    expect(parsed.formats).toEqual(['xlsx']);
    expect(parsed.includeCharts).toBe(false);
  });

  it('rejects when dateRange.to is before dateRange.from', () => {
    expect(() =>
      GenerateReportSchema.parse({
        ...base,
        dateRange: {
          from: '2026-02-01T00:00:00Z',
          to: '2026-01-01T00:00:00Z',
        },
      }),
    ).toThrow();
  });

  it('rejects when dateRange exceeds 365 days', () => {
    expect(() =>
      GenerateReportSchema.parse({
        ...base,
        dateRange: {
          from: '2025-01-01T00:00:00Z',
          to: '2026-12-31T00:00:00Z',
        },
      }),
    ).toThrow();
  });

  it('rejects duplicate formats', () => {
    expect(() => GenerateReportSchema.parse({ ...base, formats: ['pdf', 'pdf'] })).toThrow(
      /unique/i,
    );
  });

  it('rejects unknown report type', () => {
    expect(() => GenerateReportSchema.parse({ ...base, type: 'gibberish' as never })).toThrow();
  });

  it('rejects more than 50 storeIds', () => {
    const ids = Array.from({ length: 51 }, () => randomUUID());
    expect(() => GenerateReportSchema.parse({ ...base, storeIds: ids })).toThrow();
  });
});

describe('DashboardQuerySchema', () => {
  const storeId = '00000000-0000-4000-8000-000000000001';

  it('defaults to a 30-day window when only storeId is supplied', () => {
    const parsed = DashboardQuerySchema.parse({ storeId });
    const ms = parsed.to.getTime() - parsed.from.getTime();
    const days = Math.round(ms / (24 * 60 * 60 * 1000));
    expect(days).toBe(30);
  });

  it('honours an explicit daysAhead window', () => {
    const parsed = DashboardQuerySchema.parse({ storeId, daysAhead: 7 });
    const ms = parsed.to.getTime() - parsed.from.getTime();
    const days = Math.round(ms / (24 * 60 * 60 * 1000));
    expect(days).toBe(7);
  });

  it('rejects when from > to', () => {
    expect(() =>
      DashboardQuerySchema.parse({
        storeId,
        from: '2026-02-01T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  it('rejects daysAhead beyond 365', () => {
    expect(() => DashboardQuerySchema.parse({ storeId, daysAhead: 999 })).toThrow();
  });
});

describe('ScheduleReportSchema', () => {
  const params = {
    type: 'scan-history' as const,
    formats: ['csv'] as const,
    dateRange: {
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    },
  };

  it('requires dayOfWeek for weekly schedules', () => {
    expect(() =>
      ScheduleReportSchema.parse({
        type: 'scan-history',
        title: 'Weekly Scans',
        frequency: 'weekly',
        hourOfDay: 6,
        parameters: params,
      }),
    ).toThrow(/dayOfWeek/);
  });

  it('requires dayOfMonth for monthly schedules', () => {
    expect(() =>
      ScheduleReportSchema.parse({
        type: 'scan-history',
        title: 'Monthly Scans',
        frequency: 'monthly',
        hourOfDay: 6,
        parameters: params,
      }),
    ).toThrow(/dayOfMonth/);
  });

  it('accepts a daily schedule with no day fields', () => {
    const parsed = ScheduleReportSchema.parse({
      type: 'scan-history',
      title: 'Daily Scans',
      frequency: 'daily',
      hourOfDay: 6,
      parameters: params,
    });
    expect(parsed.frequency).toBe('daily');
    expect(parsed.hourOfDay).toBe(6);
  });
});

describe('ListReportsQuerySchema', () => {
  it('defaults to limit 50', () => {
    const parsed = ListReportsQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
  });

  it('rejects limit > 100', () => {
    expect(() => ListReportsQuerySchema.parse({ limit: 999 })).toThrow();
  });
});

describe('AggregateMetricsBodySchema', () => {
  it('defaults to yesterday at 00:00 UTC when no date is supplied', () => {
    const parsed = AggregateMetricsBodySchema.parse({});
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 1);
    expected.setUTCHours(0, 0, 0, 0);
    expect(parsed.date.getUTCFullYear()).toBe(expected.getUTCFullYear());
    expect(parsed.date.getUTCMonth()).toBe(expected.getUTCMonth());
    expect(parsed.date.getUTCDate()).toBe(expected.getUTCDate());
    expect(parsed.date.getUTCHours()).toBe(0);
    expect(parsed.date.getUTCMinutes()).toBe(0);
  });

  it('passes through an explicit date', () => {
    const parsed = AggregateMetricsBodySchema.parse({
      date: '2026-04-10T00:00:00Z',
    });
    expect(parsed.date.toISOString()).toBe('2026-04-10T00:00:00.000Z');
  });
});
