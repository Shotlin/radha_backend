import { LoggerService } from '@/logging/logger.service';

import { AI_DEFAULT_LIMITS } from '../ai.constants';
import { AiUsageRepository } from '../repositories/ai-usage.repository';
import { UsageTrackerService } from '../services/usage-tracker.service';

const TENANT = 'tenant-1';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildRepo = (overrides: Partial<AiUsageRepository> = {}): AiUsageRepository =>
  ({
    create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
    countForMonth: jest.fn().mockResolvedValue(0),
    countForDay: jest.fn().mockResolvedValue(0),
    getOperationBreakdown: jest.fn().mockResolvedValue([]),
    getProviderBreakdown: jest.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as AiUsageRepository;

describe('UsageTrackerService.trackUsage', () => {
  it('persists a usage row with year_month / year_month_day', async () => {
    const repo = buildRepo();
    const svc = new UsageTrackerService(repo, buildLogger());
    await svc.trackUsage({
      tenantId: TENANT,
      operation: 'ocr-expiry',
      provider: 'mlkit',
      cost: 0,
      durationMs: 5,
      success: true,
    });
    const call = (repo.create as jest.Mock).mock.calls[0][0];
    expect(call.tenantId).toBe(TENANT);
    expect(call.operation).toBe('ocr-expiry');
    expect(call.success).toBe('true');
    expect(call.yearMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(call.yearMonthDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('swallows persistence errors so user requests are not broken', async () => {
    const repo = buildRepo({
      create: jest.fn().mockRejectedValue(new Error('db down')),
    } as Partial<AiUsageRepository>);
    const logger = buildLogger();
    const svc = new UsageTrackerService(repo, logger);
    await expect(
      svc.trackUsage({
        tenantId: TENANT,
        operation: 'ocr-expiry',
        provider: 'mlkit',
        cost: 0,
        durationMs: 5,
        success: false,
      }),
    ).resolves.toBeUndefined();
    expect((logger.error as jest.Mock).mock.calls[0][0]).toBe('ai.usage.persist_failed');
  });
});

describe('UsageTrackerService.checkLimit', () => {
  it('allows when used < monthly limit', async () => {
    const repo = buildRepo({
      countForMonth: jest.fn().mockResolvedValue(0),
      countForDay: jest.fn().mockResolvedValue(0),
    } as Partial<AiUsageRepository>);
    const svc = new UsageTrackerService(repo, buildLogger());
    const out = await svc.checkLimit(TENANT, 'ocr-expiry');
    expect(out.allowed).toBe(true);
    expect(out.limit).toBe(AI_DEFAULT_LIMITS['ocr-expiry'].monthly);
  });

  it('blocks when monthly limit reached', async () => {
    const repo = buildRepo({
      countForMonth: jest.fn().mockResolvedValue(AI_DEFAULT_LIMITS['label-analysis'].monthly),
      countForDay: jest.fn().mockResolvedValue(0),
    } as Partial<AiUsageRepository>);
    const svc = new UsageTrackerService(repo, buildLogger());
    const out = await svc.checkLimit(TENANT, 'label-analysis');
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain('Monthly limit');
    expect(out.remaining).toBe(0);
  });

  it('blocks when daily limit reached even if monthly has room', async () => {
    const repo = buildRepo({
      countForMonth: jest.fn().mockResolvedValue(0),
      countForDay: jest.fn().mockResolvedValue(AI_DEFAULT_LIMITS['label-analysis'].daily ?? 0),
    } as Partial<AiUsageRepository>);
    const svc = new UsageTrackerService(repo, buildLogger());
    const out = await svc.checkLimit(TENANT, 'label-analysis');
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain('Daily limit');
  });
});

describe('UsageTrackerService.getUsageForTenant', () => {
  it('aggregates per-operation and per-provider breakdowns into UsageStats', async () => {
    const repo = buildRepo({
      getOperationBreakdown: jest.fn().mockResolvedValue([
        {
          operation: 'ocr-expiry',
          count: 5,
          successCount: 4,
          failureCount: 1,
          totalCost: 0,
          totalTokens: 0,
          avgDurationMs: 12,
        },
        {
          operation: 'label-analysis',
          count: 2,
          successCount: 2,
          failureCount: 0,
          totalCost: 0.002,
          totalTokens: 0,
          avgDurationMs: 90,
        },
      ]),
      getProviderBreakdown: jest.fn().mockResolvedValue([
        { provider: 'mlkit', count: 5, totalCost: 0, totalTokens: 0 },
        { provider: 'rekognition', count: 2, totalCost: 0.002, totalTokens: 0 },
      ]),
    } as Partial<AiUsageRepository>);
    const svc = new UsageTrackerService(repo, buildLogger());
    const out = await svc.getUsageForTenant(TENANT, {
      from: new Date('2026-01-01'),
      to: new Date('2026-02-01'),
    });
    expect(out.totalCalls).toBe(7);
    expect(out.totalCost).toBeCloseTo(0.002);
    expect(out.byOperation['ocr-expiry']?.successCount).toBe(4);
    expect(out.byProvider.rekognition?.count).toBe(2);
  });
});

describe('UsageTrackerService.estimateCost', () => {
  it('multiplies unit cost by count', () => {
    const svc = new UsageTrackerService(buildRepo(), buildLogger());
    expect(svc.estimateCost('label-analysis', 100)).toBeCloseTo(0.1, 5);
  });

  it('returns 0 for free operations', () => {
    const svc = new UsageTrackerService(buildRepo(), buildLogger());
    expect(svc.estimateCost('ocr-expiry', 1000)).toBe(0);
  });

  it('clamps negative counts to 0', () => {
    const svc = new UsageTrackerService(buildRepo(), buildLogger());
    expect(svc.estimateCost('label-analysis', -5)).toBe(0);
  });
});
