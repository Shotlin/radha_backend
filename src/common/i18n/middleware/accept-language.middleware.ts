import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '../types/locale.types';

/**
 * BE-42 — Resolves the request's preferred locale.
 *
 * Implementation notes:
 *   - Parses RFC 7231 `Accept-Language` syntax: comma-separated
 *     entries, each `lang[;q=…]`. We sort by q-weight (descending)
 *     and pick the first one that maps to a `SupportedLocale`.
 *   - Language tags can include a region (`en-US`, `hi-IN`); we
 *     match on the primary subtag only.
 *   - When no usable language is found, falls back to `'en'`.
 *
 * Authenticated routes can override this with the user's saved
 * `preferred_language` later in the pipeline (BE-42 spec, §"Middleware").
 */
@Injectable()
export class AcceptLanguageMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['accept-language'];
    (req as Request & { locale?: SupportedLocale }).locale =
      AcceptLanguageMiddleware.resolve(header);
    next();
  }

  /**
   * Public for unit-testing. Returns the first supported locale
   * referenced in the header, defaulting to `'en'`.
   */
  static resolve(header: unknown): SupportedLocale {
    const raw = AcceptLanguageMiddleware.normalizeHeader(header);
    if (!raw) return DEFAULT_LOCALE;

    const entries = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry, index) => {
        const [tag, ...params] = entry.split(';').map((part) => part.trim());
        let q = 1;
        for (const param of params) {
          if (param.startsWith('q=')) {
            const parsed = parseFloat(param.slice(2));
            if (Number.isFinite(parsed)) q = parsed;
          }
        }
        // Stable sort by (q desc, header order asc) by appending
        // index as a tie-breaker.
        return { tag, q, index };
      });

    entries.sort((a, b) => (b.q !== a.q ? b.q - a.q : a.index - b.index));

    for (const entry of entries) {
      const candidate = AcceptLanguageMiddleware.toPrimarySubtag(entry.tag);
      if (candidate === '*') {
        // RFC says `*` means "anything goes" — use the default.
        return DEFAULT_LOCALE;
      }
      if (isSupportedLocale(candidate)) {
        return candidate;
      }
    }

    return DEFAULT_LOCALE;
  }

  /** Header may arrive as string, string[], or undefined. */
  private static normalizeHeader(header: unknown): string | null {
    if (typeof header === 'string' && header.length > 0) return header;
    if (Array.isArray(header) && header.length > 0 && typeof header[0] === 'string') {
      return header[0];
    }
    return null;
  }

  /** `en-US` → `en`, leaves `*` alone. */
  private static toPrimarySubtag(tag: string): string {
    if (!tag) return '';
    if (tag === '*') return '*';
    const sub = tag.split('-')[0];
    return sub.toLowerCase();
  }
}

/** Re-exported here so callers in the i18n folder can grab both
 * the middleware class and the canonical locale list from one
 * import path. */
export { SUPPORTED_LOCALES };
