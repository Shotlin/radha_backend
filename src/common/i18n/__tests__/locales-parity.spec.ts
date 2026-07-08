import * as fs from 'fs';
import * as path from 'path';

import { SUPPORTED_LOCALES, type SupportedLocale } from '../types/locale.types';

/**
 * Static parity check for translation files. Runs over the on-disk
 * JSON without booting the service — fast and deterministic.
 */
describe('locales parity', () => {
  const localesDir = path.join(__dirname, '..', 'locales');

  /** Returns the dotted set of leaf keys in a tree. */
  const leafKeys = (tree: unknown, prefix = ''): string[] => {
    if (typeof tree !== 'object' || tree === null) return prefix ? [prefix] : [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...leafKeys(v, next));
      } else {
        out.push(next);
      }
    }
    return out.sort();
  };

  const loadLocale = (locale: SupportedLocale): Record<string, unknown> => {
    const file = path.join(localesDir, `${locale}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  };

  it('every locale file is valid JSON', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(() => loadLocale(locale)).not.toThrow();
    }
  });

  it('every supported locale has a JSON file on disk', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const file = path.join(localesDir, `${locale}.json`);
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('all six locale files share the exact same set of keys (parity)', () => {
    const baseline = leafKeys(loadLocale('en'));
    expect(baseline.length).toBeGreaterThan(20); // sanity — we ship ~25 keys

    for (const locale of SUPPORTED_LOCALES) {
      const keys = leafKeys(loadLocale(locale));
      expect({ locale, keys }).toEqual({ locale, keys: baseline });
    }
  });

  it('every value is a non-empty string', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const tree = loadLocale(locale);
      const flat = leafKeys(tree);
      for (const dottedKey of flat) {
        let cur: unknown = tree;
        for (const part of dottedKey.split('.')) {
          cur = (cur as Record<string, unknown>)[part];
        }
        expect(typeof cur).toBe('string');
        expect((cur as string).length).toBeGreaterThan(0);
      }
    }
  });
});
