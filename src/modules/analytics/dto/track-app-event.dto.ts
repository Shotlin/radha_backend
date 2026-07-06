import { z } from 'zod';

/**
 * BE-29 — Authenticated mobile event payload.
 */

export const AppEventTypeSchema = z.enum([
  'screen_view',
  'feature_use',
  'error',
  'crash',
  'performance',
]);

export const TrackAppEventSchema = z
  .object({
    eventType: AppEventTypeSchema,
    category: z.string().trim().min(1).max(50),
    action: z.string().trim().min(1).max(100),
    label: z.string().trim().max(200).optional(),
    value: z.number().finite().optional(),

    screen: z.string().trim().max(100).optional(),
    storeId: z.string().uuid().optional(),
    appVersion: z.string().trim().max(20).optional(),
    platform: z.enum(['ios', 'android']).optional(),
    deviceModel: z.string().trim().max(100).optional(),

    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type TrackAppEventDto = z.infer<typeof TrackAppEventSchema>;

export const TrackAppEventBatchSchema = z.object({
  events: z.array(TrackAppEventSchema).min(1).max(100),
});

export type TrackAppEventBatchDto = z.infer<typeof TrackAppEventBatchSchema>;
