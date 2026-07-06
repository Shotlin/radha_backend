import { SetMetadata } from '@nestjs/common';

import type { Feature } from '../types/subscription.types';

/**
 * BE-28 — Marks a controller route as requiring a specific feature
 * entitlement.
 *
 * Usage:
 *   ```ts
 *   @Post('reports/export')
 *   @RequireEntitlement('monthly_reports')
 *   exportReport(...) {}
 *   ```
 *
 * The metadata is read by `EntitlementGuard` (BE-28) — when the
 * tenant's plan doesn't allow the feature or the monthly cap has
 * been hit, the guard throws `PLAN_LIMIT_EXCEEDED` /
 * `SUBSCRIPTION_REQUIRED` (the codes pre-exist in BE-04).
 */
export const REQUIRE_ENTITLEMENT_KEY = 'subscriptions:requireEntitlement';

export const RequireEntitlement = (feature: Feature): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_ENTITLEMENT_KEY, feature);
