import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * BE-24 — Notifications & Background Jobs schema.
 *
 * Four tables in one file because they share the notification
 * lifecycle and ship in a single migration:
 *
 *   - `notifications`              — log of every send attempt. One
 *     row per send, regardless of how many channels it fans out to.
 *     Per-channel delivery status is stored on the same row so the
 *     Mobile_App can show "delivered via push, email failed".
 *
 *   - `notification_preferences`   — per-user knobs (channel toggles,
 *     category opt-outs, quiet hours, digest frequency). Single
 *     row-per-user model rather than the (user, category, channel)
 *     triple from the v2 ADDENDUM — the JSONB columns capture the
 *     same matrix without the cross-product row explosion.
 *
 *   - `notification_templates`     — DB-stored override layer for the
 *     in-process default templates. Lets Owners customise the
 *     wording of `task-assigned` etc. without a code deploy. Rows
 *     are tenant-scoped; nullable `tenant_id` rows are platform
 *     defaults (seeder-friendly).
 *
 *   - `device_tokens`              — FCM device tokens (v2 ADDENDUM
 *     Req 28). Permanent-failure tokens are flipped to inactive
 *     by `FcmTokenCleanupService` so we stop hammering dead
 *     subscriptions.
 *
 * Tenant scoping is required on `notifications` and
 * `notification_templates`; preferences and device tokens are
 * keyed by `user_id` and inherit tenant scope through the parent
 * user row.
 */

export const notificationStatusEnum = pgEnum('notification_status', [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'bounced',
  'skipped',
]);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'email',
  'sms',
  'push',
  'in-app',
]);

export const notificationPriorityEnum = pgEnum('notification_priority', [
  'low',
  'normal',
  'high',
  'urgent',
]);

export const notificationCategoryEnum = pgEnum('notification_category', [
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

export const devicePlatformEnum = pgEnum('device_platform', ['ios', 'android', 'web']);

/* ─────────────────── notifications ─────────────────── */

export const notifications = pgTable(
  'notifications',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),

    category: notificationCategoryEnum('category').notNull(),
    /** Optional template id (`task-assigned`, `expiry-near`, ...). */
    template: varchar('template', { length: 50 }),

    subject: varchar('subject', { length: 200 }).notNull(),
    body: varchar('body', { length: 2000 }).notNull(),
    bodyHtml: varchar('body_html', { length: 10000 }),

    priority: notificationPriorityEnum('priority').notNull().default('normal'),

    /** Snapshot of the channels that were chosen at send time. */
    channels: jsonb('channels').$type<string[]>().notNull().default([]),

    // Per-channel delivery status — null when the channel wasn't selected.
    emailStatus: notificationStatusEnum('email_status'),
    smsStatus: notificationStatusEnum('sms_status'),
    pushStatus: notificationStatusEnum('push_status'),
    inAppStatus: notificationStatusEnum('in_app_status'),

    // Mailbox semantics.
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),

    // Lifecycle.
    sentAt: timestamp('sent_at', { withTimezone: true }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    /** When BullMQ retries are exhausted, populated by the processor. */
    failedAt: timestamp('failed_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),

    // Deep-link material — points at the resource that triggered the send.
    relatedResourceType: varchar('related_resource_type', { length: 50 }),
    relatedResourceId: uuid('related_resource_id'),

    /** Free-form data carried to the Mobile_App for in-app rendering. */
    data: jsonb('data').$type<Record<string, unknown>>().default({}),
    error: varchar('error', { length: 1000 }),
  },
  (t) => ({
    userCreatedIdx: index('notifications_user_created_idx').on(t.userId, t.createdAt),
    tenantCreatedIdx: index('notifications_tenant_created_idx').on(t.tenantId, t.createdAt),
    unreadIdx: index('notifications_user_unread_idx').on(t.userId, t.isRead),
    categoryIdx: index('notifications_category_idx').on(t.tenantId, t.category),
    scheduledIdx: index('notifications_scheduled_idx').on(t.scheduledFor),
    relatedIdx: index('notifications_related_idx').on(t.relatedResourceType, t.relatedResourceId),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/* ─────────────────── notification_preferences ─────────────────── */

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    ...baseColumns,
    userId: uuid('user_id').notNull(),
    tenantId: uuid('tenant_id'),

    /** Channel-level master toggles. */
    emailEnabled: boolean('email_enabled').notNull().default(true),
    smsEnabled: boolean('sms_enabled').notNull().default(true),
    pushEnabled: boolean('push_enabled').notNull().default(true),
    inAppEnabled: boolean('in_app_enabled').notNull().default(true),

    /**
     * Category opt-outs. Stored as a JSONB map of
     * `category -> boolean` (default = enabled when key is absent).
     */
    categoryOptIns: jsonb('category_opt_ins')
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),

    quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(false),
    quietHoursStart: varchar('quiet_hours_start', { length: 5 }), // HH:MM
    quietHoursEnd: varchar('quiet_hours_end', { length: 5 }), // HH:MM
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Kolkata'),

    digestFrequency: varchar('digest_frequency', { length: 16 }).notNull().default('realtime'),
  },
  (t) => ({
    userUniq: uniqueIndex('notification_preferences_user_uniq').on(t.userId),
  }),
);

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;

/* ─────────────────── notification_templates ─────────────────── */

export const notificationTemplates = pgTable(
  'notification_templates',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    /** Null = platform default (seeded). Non-null = tenant override. */
    tenantId: uuid('tenant_id'),

    /** Stable key like `task-assigned`, `expiry-near`. */
    key: varchar('key', { length: 50 }).notNull(),
    locale: varchar('locale', { length: 8 }).notNull().default('en'),

    subject: varchar('subject', { length: 200 }).notNull(),
    body: varchar('body', { length: 2000 }).notNull(),
    bodyHtml: varchar('body_html', { length: 10000 }),
    smsText: varchar('sms_text', { length: 480 }),
    pushTitle: varchar('push_title', { length: 200 }),
    pushBody: varchar('push_body', { length: 500 }),

    category: notificationCategoryEnum('category').notNull(),
    /** Default channels when caller doesn't override. */
    defaultChannels: jsonb('default_channels').$type<string[]>().notNull().default([]),

    isActive: boolean('is_active').notNull().default(true),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    /**
     * One template per (tenant, key, locale). Platform defaults use
     * a NULL tenant — the partial unique index handles that pair so
     * we can have one global default per (key, locale).
     */
    tenantKeyUniq: uniqueIndex('notification_templates_tenant_key_uniq')
      .on(t.tenantId, t.key, t.locale)
      .where(sql`tenant_id IS NOT NULL AND deleted_at IS NULL`),
    globalKeyUniq: uniqueIndex('notification_templates_global_key_uniq')
      .on(t.key, t.locale)
      .where(sql`tenant_id IS NULL AND deleted_at IS NULL`),
    keyIdx: index('notification_templates_key_idx').on(t.key),
  }),
);

export type NotificationTemplateRow = typeof notificationTemplates.$inferSelect;
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert;

/* ─────────────────── device_tokens ─────────────────── */

export const deviceTokens = pgTable(
  'device_tokens',
  {
    ...baseColumns,
    userId: uuid('user_id').notNull(),
    tenantId: uuid('tenant_id'),

    token: varchar('token', { length: 500 }).notNull(),
    platform: devicePlatformEnum('platform').notNull(),

    deviceId: varchar('device_id', { length: 255 }),
    appVersion: varchar('app_version', { length: 32 }),

    isActive: boolean('is_active').notNull().default(true),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidationReason: varchar('invalidation_reason', { length: 64 }),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    /**
     * One row per token. Re-registering the same token by another
     * user transfers ownership (handled at the service layer with
     * an UPSERT-on-conflict path).
     */
    tokenUniq: uniqueIndex('device_tokens_token_uniq').on(t.token),
    userIdx: index('device_tokens_user_idx').on(t.userId, t.isActive),
    activeIdx: index('device_tokens_active_idx').on(t.isActive),
  }),
);

export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type NewDeviceToken = typeof deviceTokens.$inferInsert;
