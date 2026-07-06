/**
 * BE-42 — Express `Request` augmentation.
 *
 * Adds `req.locale` so downstream handlers can read the value
 * resolved by `AcceptLanguageMiddleware` without re-parsing the
 * `Accept-Language` header. Lives in a stand-alone `.d.ts` so the
 * augmentation is picked up by every consumer (controllers, tests,
 * and any future middleware that reads `req.locale`) regardless of
 * import order.
 */

import type { SupportedLocale } from './locale.types';

declare module 'express-serve-static-core' {
  interface Request {
    locale?: SupportedLocale;
  }
}

export {};
