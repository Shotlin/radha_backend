import type { DbService } from '@/db/db.service';
import type { LoggerService } from '@/logging/logger.service';

import { SlugService } from '../services/slug.service';

/**
 * BE-51 — `SlugService` unit tests.
 *
 * The pure helper (`SlugService.kebab` / `SlugService.composeBase`)
 * is tested without any Nest container. The collision-retry path
 * uses a hand-rolled fake DbService that returns `taken` for the
 * first N candidates and frees the (N+1)-th, so we can prove the
 * loop walks `slug`, `slug-2`, `slug-3`, … in order.
 */

/**
 * Build a fake `DbService` whose `select(...).from(...).where(...)`
 * `.limit(...)` chain returns whatever the predicate decides for
 * the slug it sees.
 */
function buildDb(predicate: (slug: string) => boolean) {
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: (cond: { _slugProbe?: string } | unknown) => ({
            limit: async () => {
              const probe = (cond as { _slugProbe?: string })?._slugProbe ?? '';
              return predicate(probe) ? [{ id: 'collision' }] : [];
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    }),
  } as unknown as DbService;
}

const noopLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as LoggerService;

describe('SlugService.kebab', () => {
  it('lowercases and replaces non-alphanumeric runs with single hyphens', () => {
    expect(SlugService.kebab('Maggi 2-Minute Noodles!')).toBe('maggi-2-minute-noodles');
  });

  it('strips diacritics so unicode names produce ASCII slugs', () => {
    expect(SlugService.kebab('Café — naïve')).toBe('cafe-naive');
  });

  it('falls back to "product" for empty / whitespace / null input', () => {
    expect(SlugService.kebab('')).toBe('product');
    expect(SlugService.kebab('   ')).toBe('product');
    expect(SlugService.kebab(null)).toBe('product');
    expect(SlugService.kebab(undefined)).toBe('product');
  });

  it('falls back to "product" when the input slugs to nothing', () => {
    expect(SlugService.kebab('!!!@#$%')).toBe('product');
  });

  it('truncates long names and trims the trailing hyphen left by the cut', () => {
    const long = 'a'.repeat(80);
    const slug = SlugService.kebab(long, 50);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('is idempotent — slugifying a slug returns the same slug', () => {
    const once = SlugService.kebab('Mono Sodium Glutamate');
    expect(SlugService.kebab(once)).toBe(once);
  });
});

describe('SlugService.composeBase', () => {
  it('composes name and last-4 of EAN into a deterministic slug', () => {
    expect(SlugService.composeBase('Maggi Noodles', '8901058869293')).toBe(
      'maggi-noodles-9293',
    );
  });

  it('is deterministic across re-renders for the same input', () => {
    const a = SlugService.composeBase('Maggi Noodles', '8901058869293');
    const b = SlugService.composeBase('Maggi Noodles', '8901058869293');
    expect(a).toBe(b);
  });

  it('zero-pads the EAN suffix when fewer than 4 digits are available', () => {
    expect(SlugService.composeBase('X', '12')).toBe('x-12');
    expect(SlugService.composeBase('X', '')).toBe('x-0000');
  });

  it('strips non-digits before slicing the EAN', () => {
    expect(SlugService.composeBase('Pasta', 'abc-1234')).toBe('pasta-1234');
  });
});

describe('SlugService.generate (collision retry)', () => {
  /**
   * Fake-DB harness: instead of inspecting the Drizzle SQL we
   * intercept the `where` call and read the slug literal via a
   * patched accessor. The cleanest way to do that without coupling
   * to drizzle internals is to spy on the service's private
   * `isSlugTaken` method.
   */
  function buildSvc(takenSet: Set<string>) {
    const svc = new SlugService(buildDb(() => false), noopLogger);
    jest
      .spyOn(svc as unknown as { isSlugTaken: (s: string) => Promise<boolean> }, 'isSlugTaken')
      .mockImplementation(async (slug: string) => takenSet.has(slug));
    return svc;
  }

  it('returns the deterministic base slug when no collision exists', async () => {
    const svc = buildSvc(new Set());
    const slug = await svc.generate('Maggi Noodles', '8901058869293');
    expect(slug).toBe('maggi-noodles-9293');
  });

  it('walks "-2", "-3" suffixes when the base slug is taken', async () => {
    const svc = buildSvc(new Set(['maggi-noodles-9293', 'maggi-noodles-9293-2']));
    const slug = await svc.generate('Maggi Noodles', '8901058869293');
    expect(slug).toBe('maggi-noodles-9293-3');
  });

  it('emits a fallback slug after exhausting MAX_COLLISION_RETRIES attempts', async () => {
    // Mark every conceivable suffix as taken so the loop runs to its limit.
    const taken = new Set<string>();
    for (let i = 0; i <= 60; i += 1) {
      taken.add(i === 0 ? 'maggi-noodles-9293' : `maggi-noodles-9293-${i + 1}`);
    }
    const svc = buildSvc(taken);
    const slug = await svc.generate('Maggi Noodles', '8901058869293');
    expect(slug.startsWith('maggi-noodles-9293-')).toBe(true);
    expect(slug).not.toBe('maggi-noodles-9293');
  });

  it('produces the same slug for the same input on repeated calls (deterministic)', async () => {
    const svc = buildSvc(new Set());
    const a = await svc.generate('Cadbury Dairy Milk', '8901058832001');
    const b = await svc.generate('Cadbury Dairy Milk', '8901058832001');
    expect(a).toBe(b);
  });
});
