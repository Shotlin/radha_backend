import { LocalStaticProvider } from '../providers/local-static.provider';
import { FeatureFlagsService } from '../services/feature-flags.service';
import {
  FeatureFlagUser,
  IFlagProvider,
} from '../types/feature-flag.types';

/**
 * BE-47 — `FeatureFlagsService` unit tests.
 *
 * These cover the service-level guarantees the BE-47 brief calls out:
 *
 *   - boolean / multivariate evaluation forwards to the provider,
 *   - rollouts are deterministic per bucket key (sticky),
 *   - provider throws → fall back to the flag's default + warn log,
 *   - cache hits land in well under 5 ms,
 *   - per-tenant cache key prefix prevents bleed-through.
 */

interface FakeLogger {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
  verbose: jest.Mock;
  log: jest.Mock;
  logError: jest.Mock;
  child: jest.Mock;
}

const makeLogger = (): FakeLogger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
  log: jest.fn(),
  logError: jest.fn(),
  child: jest.fn(),
});

const USER_A: FeatureFlagUser = { id: 'user-a', tenantId: 'tenant-1' };
const USER_B: FeatureFlagUser = { id: 'user-b', tenantId: 'tenant-2' };

describe('FeatureFlagsService', () => {
  let provider: LocalStaticProvider;
  let logger: FakeLogger;
  let service: FeatureFlagsService;

  const errorTracking = {
    captureMessage: jest.fn(),
    captureException: jest.fn(),
    setUser: jest.fn(),
    clearUser: jest.fn(),
    addBreadcrumb: jest.fn(),
    setTag: jest.fn(),
    setContext: jest.fn(),
  };

  beforeEach(() => {
    provider = new LocalStaticProvider({
      shiny_button: { type: 'boolean', default: true },
      rollout_50: { type: 'rollout', percentage: 50, default: 'off', on: 'on' },
      color_test: {
        type: 'multivariate',
        variants: ['A', 'B', 'C'],
        weights: [50, 30, 20],
      },
      kill_switch: { type: 'boolean', default: false },
    });
    logger = makeLogger();
    Object.values(errorTracking).forEach((fn) => fn.mockReset?.());
    service = new FeatureFlagsService(
      provider,
      logger as unknown as ConstructorParameters<typeof FeatureFlagsService>[1],
      provider,
      errorTracking,
    );
  });

  describe('isEnabled', () => {
    it("returns true for a boolean flag whose default is true", async () => {
      await expect(service.isEnabled('shiny_button', USER_A)).resolves.toBe(true);
    });

    it("returns false for a boolean flag whose default is false", async () => {
      await expect(service.isEnabled('kill_switch', USER_A)).resolves.toBe(false);
    });

    it("returns false for an unknown flag", async () => {
      await expect(service.isEnabled('mystery', USER_A)).resolves.toBe(false);
    });
  });

  describe('getVariant', () => {
    it('returns one of the declared multivariate variants', async () => {
      const v = await service.getVariant('color_test', USER_A);
      expect(['A', 'B', 'C']).toContain(v);
    });

    it('is deterministic for the same user (sticky bucketing)', async () => {
      const x = await service.getVariant('rollout_50', USER_A);
      const y = await service.getVariant('rollout_50', USER_A);
      expect(x).toBe(y);
    });

    it('emits a feature_flag_evaluated breadcrumb on first evaluation', async () => {
      await service.getVariant('shiny_button', USER_A);
      const calls = logger.info.mock.calls.filter(
        ([msg]) => msg === 'feature_flag_evaluated',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({
        flag: 'shiny_button',
        variant: 'on',
        userId: USER_A.id,
        tenantId: USER_A.tenantId,
      });
    });
  });

  describe('cache', () => {
    it('returns cache hits in well under 5 ms', async () => {
      // Prime
      await service.getVariant('shiny_button', USER_A);

      const evalSpy = jest.spyOn(provider, 'evaluate');
      const start = process.hrtime.bigint();
      const result = await service.getVariant('shiny_button', USER_A);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

      expect(result).toBe('on');
      expect(elapsedMs).toBeLessThan(5);
      // Provider must NOT have been re-invoked on a cache hit.
      expect(evalSpy).not.toHaveBeenCalled();
    });

    it('keeps separate cache entries per tenant', async () => {
      // Same user-id under two different tenants should be evaluated
      // independently — the provider is called once per (tenant, user)
      // pair, not once per user-id.
      const sameUserDifferentTenant: FeatureFlagUser = {
        id: USER_A.id,
        tenantId: 'tenant-other',
      };
      const evalSpy = jest.spyOn(provider, 'evaluate');

      await service.getVariant('shiny_button', USER_A);
      await service.getVariant('shiny_button', sameUserDifferentTenant);

      // Two evaluations: USER_A (tenant-1) + USER_A (tenant-other).
      const flagCalls = evalSpy.mock.calls.filter(([f]) => f === 'shiny_button');
      expect(flagCalls).toHaveLength(2);

      // And subsequent reads are cached per-tenant.
      evalSpy.mockClear();
      await service.getVariant('shiny_button', USER_A);
      await service.getVariant('shiny_button', sameUserDifferentTenant);
      expect(evalSpy).not.toHaveBeenCalled();
    });
  });

  describe('provider failure → fallback', () => {
    it("falls back to the flag's default and warns when the provider throws", async () => {
      const failing: IFlagProvider = {
        evaluate: jest.fn().mockRejectedValue(new Error('boom')),
        list: jest.fn().mockResolvedValue(['shiny_button']),
        refresh: jest.fn().mockResolvedValue(undefined),
      };
      const fallbackService = new FeatureFlagsService(
        failing,
        logger as unknown as ConstructorParameters<typeof FeatureFlagsService>[1],
        provider, // localStatic kept around for default lookup
        errorTracking,
      );

      // shiny_button default = true → fallback variant is 'on'
      await expect(fallbackService.getVariant('shiny_button', USER_A)).resolves.toBe('on');
      expect(logger.warn).toHaveBeenCalledWith(
        'feature-flags.provider.error',
        expect.objectContaining({ flag: 'shiny_button' }),
      );
      expect(errorTracking.captureMessage).toHaveBeenCalled();
    });

    it("returns 'off' when the provider throws AND no static default is known", async () => {
      const failing: IFlagProvider = {
        evaluate: jest.fn().mockRejectedValue(new Error('boom')),
        list: jest.fn().mockRejectedValue(new Error('boom')),
        refresh: jest.fn().mockResolvedValue(undefined),
      };
      const noDefaults = new LocalStaticProvider({});
      const svc = new FeatureFlagsService(
        failing,
        logger as unknown as ConstructorParameters<typeof FeatureFlagsService>[1],
        noDefaults,
        errorTracking,
      );
      await expect(svc.getVariant('unknown_flag', USER_A)).resolves.toBe('off');
    });
  });

  describe('getAll', () => {
    it('returns one variant per flag known to the provider', async () => {
      const all = await service.getAll(USER_A);
      expect(Object.keys(all).sort()).toEqual([
        'color_test',
        'kill_switch',
        'rollout_50',
        'shiny_button',
      ]);
      expect(all.shiny_button).toBe('on');
      expect(all.kill_switch).toBe('off');
    });

    it('is independent per user (no cross-bleed)', async () => {
      const a = await service.getAll(USER_A);
      const b = await service.getAll(USER_B);
      expect(a.shiny_button).toBe('on');
      expect(b.shiny_button).toBe('on');
      // The booleans are tenant-agnostic, but the call paths must not
      // throw or mix entries.
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    });
  });
});
