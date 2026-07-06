import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './types/locale.types';

/**
 * BE-42 — Translation lookup service.
 *
 * Loads each `locales/<locale>.json` file once at module init and
 * keeps the parsed objects in memory. `t(key, locale, params)`:
 *
 *   1. Splits `key` on `.` and walks the requested locale's tree.
 *   2. If the value is a non-string (missing leaf, or a sub-object)
 *      it falls back to `en`.
 *   3. If `en` is also missing the key, the key string itself is
 *      returned (defensive — keeps the response shape stable so
 *      Mobile_App never receives `undefined`).
 *   4. Replaces `{paramName}` placeholders with `params[paramName]`.
 *      Unknown placeholders are left intact so a partial-params bug
 *      surfaces visibly in QA rather than silently dropping text.
 *
 * Loading is synchronous and happens in `onModuleInit` so callers
 * never have to await initialisation. The locales directory ships
 * with the source under `src/common/i18n/locales/` and the same
 * relative path is used at runtime under `dist/`.
 */
@Injectable()
export class I18nService implements OnModuleInit {
  private readonly logger = new Logger(I18nService.name);

  /** Parsed locale trees keyed by locale code. */
  private readonly translations: Map<SupportedLocale, Record<string, unknown>> = new Map();

  onModuleInit(): void {
    this.loadAll();
  }

  /**
   * Public lookup. Always returns a string — never `undefined`.
   */
  t(key: string, locale: SupportedLocale, params?: Record<string, string>): string {
    if (!key) return key;

    const requested = this.lookup(key, locale);
    if (requested !== null) {
      return this.interpolate(requested, params);
    }

    if (locale !== DEFAULT_LOCALE) {
      const fallback = this.lookup(key, DEFAULT_LOCALE);
      if (fallback !== null) {
        return this.interpolate(fallback, params);
      }
    }

    // Defensive: missing in en too — return the key so the caller
    // can see exactly what's missing instead of a blank string.
    return key;
  }

  /**
   * Returns the in-memory tree for tests / debugging.
   */
  getTranslations(locale: SupportedLocale): Record<string, unknown> | undefined {
    return this.translations.get(locale);
  }

  /**
   * Reload from disk — only used in tests.
   */
  reload(): void {
    this.translations.clear();
    this.loadAll();
  }

  // ──────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────

  private loadAll(): void {
    const dir = this.resolveLocalesDir();
    for (const locale of SUPPORTED_LOCALES) {
      const file = path.join(dir, `${locale}.json`);
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        this.translations.set(locale, parsed);
      } catch (err) {
        // Failing to load a locale file is a deployment bug — log
        // and seed an empty tree so `t()` gracefully falls back
        // to English / the key itself.
        this.logger.error(
          `Failed to load i18n locale "${locale}" from ${file}: ${(err as Error).message}`,
        );
        this.translations.set(locale, {});
      }
    }
  }

  /**
   * Walk the dotted `key` against `locale`'s tree and return a string
   * leaf, or `null` if the key is missing / points at a non-string.
   */
  private lookup(key: string, locale: SupportedLocale): string | null {
    const tree = this.translations.get(locale);
    if (!tree) return null;
    const parts = key.split('.');
    let current: unknown = tree;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in (current as object)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }
    return typeof current === 'string' ? current : null;
  }

  /**
   * `{paramName}` → `params.paramName`. Unknown placeholders are
   * left intact (visible in output, surfaces missing-param bugs).
   */
  private interpolate(template: string, params?: Record<string, string>): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name];
      return value === undefined ? match : value;
    });
  }

  /**
   * Locales ship next to the compiled service file at runtime
   * (`dist/common/i18n/locales/`), and next to the source at
   * test time. `__dirname` resolves to whichever is in play.
   */
  private resolveLocalesDir(): string {
    return path.join(__dirname, 'locales');
  }
}
