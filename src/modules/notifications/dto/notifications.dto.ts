import { z } from 'zod';

/**
 * BE-24 — Zod DTOs for the notifications HTTP surface.
 *
 * Consolidated into one file (matches BE-15/16/17/18/19/20 convention).
 * Every schema caps lengths and array sizes so the controller can't
 * be tricked into queueing huge payloads.
 */

const ChannelSchema = z.enum(['email', 'sms', 'push', 'in-app']);

const CategorySchema = z.enum([
  'auth',
  'expiry-alert',
  'task',
  'report',
  'system',
  'marketing',
  'recall-alert',
  'daily-insights',
  'business-activation',
]);

const PrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

/* ────────── List + read ────────── */

export const ListNotificationsQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  category: CategorySchema.optional(),
  unreadOnly: z.coerce.boolean().default(false),
});
export type ListNotificationsQueryDto = z.infer<typeof ListNotificationsQuerySchema>;

/* ────────── Preferences ────────── */

export const QuietHoursSchema = z.object({
  enabled: z.boolean(),
  start: TimeSchema,
  end: TimeSchema,
  timezone: z.string().min(1).max(64),
});

const CategoryOptInsSchema = z
  .record(CategorySchema, z.boolean())
  .refine((m) => Object.keys(m).length <= 32, 'Too many category overrides');

export const UpdatePreferencesSchema = z
  .object({
    channels: z
      .object({
        email: z.boolean().optional(),
        sms: z.boolean().optional(),
        push: z.boolean().optional(),
        inApp: z.boolean().optional(),
      })
      .strict()
      .optional(),
    categories: CategoryOptInsSchema.optional(),
    quietHours: QuietHoursSchema.optional(),
    digestFrequency: z.enum(['realtime', 'daily', 'weekly']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'At least one preference field is required');
export type UpdatePreferencesDtoSchema = z.infer<typeof UpdatePreferencesSchema>;

/* ────────── Test send (admin) ────────── */

export const TestNotificationSchema = z.object({
  userId: z.string().uuid(),
  channels: z.array(ChannelSchema).min(1).max(4),
  category: CategorySchema,
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  bodyHtml: z.string().max(10_000).optional(),
  priority: PrioritySchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TestNotificationDto = z.infer<typeof TestNotificationSchema>;

/* ────────── Device tokens (FCM) ────────── */

export const RegisterDeviceTokenSchema = z.object({
  token: z.string().min(20).max(500),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().max(255).optional(),
  appVersion: z.string().max(32).optional(),
});
export type RegisterDeviceTokenDtoSchema = z.infer<typeof RegisterDeviceTokenSchema>;

export const UnregisterDeviceTokenSchema = z.object({
  token: z.string().min(20).max(500),
});
export type UnregisterDeviceTokenDto = z.infer<typeof UnregisterDeviceTokenSchema>;
