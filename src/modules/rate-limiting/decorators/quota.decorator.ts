import { SetMetadata } from '@nestjs/common';

import type { QuotaKind } from '../dto/rate-limit-result.dto';

/**
 * BE-46 — Marks a controller route as gated by a per-user quota.
 *
 * Usage:
 *   ```ts
 *   @Post('scans')
 *   @Quota('scan')
 *   createScan(...) { ... }
 *
 *   @Post('saved-products')
 *   @Quota('save')
 *   saveProduct(...) { ... }
 *   ```
 *
 * The metadata is read by `QuotaGuard`. When the user's daily
 * (free consumer) or monthly (trial_pro / starter) quota for the
 * given kind has been exceeded, the guard throws an `HttpException`
 * with status 429 and a structured body containing `quota`, `limit`,
 * `used`, and `resetAt`.
 *
 * The decorator is intentionally a single-arg form — combining
 * scan + save on the same handler doesn't model any real endpoint
 * we have, and forcing a choice keeps the metadata easy to reason
 * about in audit trails.
 */
export const QUOTA_METADATA_KEY = 'rate-limiting:quota';

export const Quota = (kind: QuotaKind): MethodDecorator & ClassDecorator =>
  SetMetadata(QUOTA_METADATA_KEY, kind);
