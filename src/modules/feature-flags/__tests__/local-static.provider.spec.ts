import { LocalStaticProvider } from '../providers/local-static.provider';
import type { FeatureFlagsConfig } from '../dto/feature-flag.dto';

/**
 * BE-47 — `LocalStaticProvider` unit tests.
 *
 * The provider is the bottom of the stack — sticky bucketing,
 * percent rollouts, multivariate weighting, and FNV-1a hashing all
 * live here. We verify each mode in isolation; the higher-level
 * service tests cover caching + fallback.
 */
describe('LocalStaticProvider', () => {
  const mkProvider = (seed: FeatureFlagsConfig) => new LocalStaticProvider(seed);

  describe('boolean flags', () => {
    it("returns 'on' when default is true", async () => {
      const provider = mkProvider({
        shiny_button: { type: 'boolean', default: true },
      });
      await expect(provider.evaluate('shiny_button', 'user-1')).resolves.toBe('on');
    });

    it("returns 'off' when default is false", async () => {
      const provider = mkProvider({
        shiny_button: { type: 'boolean', default: false },
      });
      await expect(provider.evaluate('shiny_button', 'user-1')).resolves.toBe('off');
    });
  });

  describe('unknown flags', () => {
    it("returns 'off' for any flag not present in the table", async () => {
      const provider = mkProvider({});
      await expect(provider.evaluate('mystery', 'user-1')).resolves.toBe('off');
    });
  });

  describe('rollout flags', () => {
    it('returns the same variant for the same bucket key (sticky)', async () => {
      const provider = mkProvider({
        rollout_50: { type: 'rollout', percentage: 50, default: 'off', on: 'on' },
      });
      const a = await provider.evaluate('rollout_50', 'user-42');
      const b = await provider.evaluate('rollout_50', 'user-42');
      expect(a).toBe(b);
    });

    it('puts everyone in the on cohort at percentage = 100', async () => {
      const provider = mkProvider({
        full: { type: 'rollout', percentage: 100, default: 'off', on: 'on' },
      });
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        await expect(provider.evaluate('full', id)).resolves.toBe('on');
      }
    });

    it('puts no one in the on cohort at percentage = 0', async () => {
      const provider = mkProvider({
        none: { type: 'rollout', percentage: 0, default: 'off', on: 'on' },
      });
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        await expect(provider.evaluate('none', id)).resolves.toBe('off');
      }
    });

    it('approximates the configured percentage across many keys', async () => {
      const provider = mkProvider({
        rollout_50: { type: 'rollout', percentage: 50, default: 'off', on: 'on' },
      });
      let on = 0;
      const N = 2000;
      for (let i = 0; i < N; i++) {
        if ((await provider.evaluate('rollout_50', `user-${i}`)) === 'on') on++;
      }
      // 50% bucket; allow ±5% slack so the test isn't brittle.
      const ratio = on / N;
      expect(ratio).toBeGreaterThan(0.45);
      expect(ratio).toBeLessThan(0.55);
    });
  });

  describe('multivariate flags', () => {
    it('returns one of the declared variants', async () => {
      const provider = mkProvider({
        color_test: {
          type: 'multivariate',
          variants: ['A', 'B', 'C'],
          weights: [50, 30, 20],
        },
      });
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        seen.add(await provider.evaluate('color_test', `user-${i}`));
      }
      for (const v of seen) {
        expect(['A', 'B', 'C']).toContain(v);
      }
      // Sanity: at 200 keys we expect to see >1 variant for a real
      // multivariate flag (otherwise the bucketing collapsed).
      expect(seen.size).toBeGreaterThan(1);
    });

    it('is sticky for a given bucket key', async () => {
      const provider = mkProvider({
        color_test: {
          type: 'multivariate',
          variants: ['A', 'B', 'C'],
          weights: [1, 1, 1],
        },
      });
      const x = await provider.evaluate('color_test', 'user-stable');
      for (let i = 0; i < 5; i++) {
        await expect(provider.evaluate('color_test', 'user-stable')).resolves.toBe(x);
      }
    });

    it('roughly honours the declared weights', async () => {
      const provider = mkProvider({
        skewed: {
          type: 'multivariate',
          variants: ['A', 'B'],
          weights: [80, 20],
        },
      });
      const counts: Record<string, number> = { A: 0, B: 0 };
      const N = 3000;
      for (let i = 0; i < N; i++) {
        counts[await provider.evaluate('skewed', `user-${i}`)]++;
      }
      const aRatio = counts.A / N;
      // 80/20 split, allow ±5% slack.
      expect(aRatio).toBeGreaterThan(0.75);
      expect(aRatio).toBeLessThan(0.85);
    });
  });

  describe('list', () => {
    it('returns all configured flag names', async () => {
      const provider = mkProvider({
        a: { type: 'boolean', default: true },
        b: { type: 'rollout', percentage: 10, default: 'off', on: 'on' },
      });
      const names = await provider.list();
      expect(names.sort()).toEqual(['a', 'b']);
    });
  });

  describe('refresh from FEATURE_FLAGS_JSON', () => {
    const ORIGINAL = process.env.FEATURE_FLAGS_JSON;

    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env.FEATURE_FLAGS_JSON;
      } else {
        process.env.FEATURE_FLAGS_JSON = ORIGINAL;
      }
    });

    it('loads valid JSON', async () => {
      process.env.FEATURE_FLAGS_JSON = JSON.stringify({
        env_loaded: { type: 'boolean', default: true },
      });
      const provider = new LocalStaticProvider();
      await provider.refresh();
      await expect(provider.evaluate('env_loaded', 'u')).resolves.toBe('on');
    });

    it('falls back to an empty table on invalid JSON', async () => {
      process.env.FEATURE_FLAGS_JSON = '{ not-json';
      const provider = new LocalStaticProvider();
      await provider.refresh();
      await expect(provider.evaluate('any', 'u')).resolves.toBe('off');
    });

    it('falls back to an empty table on shape-invalid config', async () => {
      process.env.FEATURE_FLAGS_JSON = JSON.stringify({
        bad: { type: 'multivariate', variants: ['A'], weights: [] },
      });
      const provider = new LocalStaticProvider();
      await provider.refresh();
      await expect(provider.evaluate('bad', 'u')).resolves.toBe('off');
    });
  });
});
