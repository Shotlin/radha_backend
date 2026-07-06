import { z } from 'zod';

/**
 * BE-29 — Date-range query used by website stats and funnel endpoints.
 */

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .or(z.string().datetime());

export const WebsiteStatsQuerySchema = z
  .object({
    from: IsoDate,
    to: IsoDate,
  })
  .strict()
  .refine(
    (v) => {
      const f = new Date(v.from).getTime();
      const t = new Date(v.to).getTime();
      return Number.isFinite(f) && Number.isFinite(t) && f <= t;
    },
    { message: 'from must be on or before to' },
  );

export type WebsiteStatsQueryDto = z.infer<typeof WebsiteStatsQuerySchema>;
