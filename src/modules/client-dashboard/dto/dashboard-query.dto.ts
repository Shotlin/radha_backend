import { z } from 'zod';

/**
 * BE-30 — DTOs for the dashboard endpoints.
 *
 * Each endpoint takes only a small number of optional knobs:
 *   - `storeId` (UUID) — selects the store. Owners may omit it for
 *     the multi-store summary endpoint.
 *   - `from`/`to` (ISO date) — narrow the date window. Defaults to
 *     "last 30 days ending now" inside the service.
 *   - `limit` — for the activity feed only.
 *
 * Defaults live in the service so the DTO stays a thin validation
 * boundary.
 */

const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export const DashboardQuerySchema = z
  .object({
    storeId: z.string().uuid(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict();

export type DashboardQueryDto = z.infer<typeof DashboardQuerySchema>;

export const KpisQuerySchema = DashboardQuerySchema;
export type KpisQueryDto = z.infer<typeof KpisQuerySchema>;

export const TrendsQuerySchema = DashboardQuerySchema;
export type TrendsQueryDto = z.infer<typeof TrendsQuerySchema>;

export const TeamQuerySchema = DashboardQuerySchema;
export type TeamQueryDto = z.infer<typeof TeamQuerySchema>;

export const AlertsQuerySchema = z
  .object({
    storeId: z.string().uuid(),
  })
  .strict();
export type AlertsQueryDto = z.infer<typeof AlertsQuerySchema>;

export const QuickActionsQuerySchema = AlertsQuerySchema;
export type QuickActionsQueryDto = z.infer<typeof QuickActionsQuerySchema>;

export const ActivityQuerySchema = z
  .object({
    storeId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ActivityQueryDto = z.infer<typeof ActivityQuerySchema>;

export const HealthScoreQuerySchema = AlertsQuerySchema;
export type HealthScoreQueryDto = z.infer<typeof HealthScoreQuerySchema>;
