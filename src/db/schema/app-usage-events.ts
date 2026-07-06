import { decimal, index, jsonb, pgEnum, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-29 — Mobile / app usage events.
 *
 * Authenticated callers only. Tenant scoping is mandatory at write
 * time so a user cannot leak events into another tenant's bucket.
 *
 * Privacy notes:
 *   - `metadata` is redacted via `redactPII` before insert.
 *   - `value` is a generic numeric so we can capture timing /
 *     performance metrics without a per-event column.
 *   - No raw IP, no device id beyond a model string (e.g. "iPhone 14").
 */

export const appEventTypeEnum = pgEnum('app_event_type', [
  'screen_view',
  'feature_use',
  'error',
  'crash',
  'performance',
]);

export const appUsageEvents = pgTable(
  'app_usage_events',
  {
    ...baseColumns,
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    storeId: uuid('store_id'),

    eventType: appEventTypeEnum('event_type').notNull(),
    category: varchar('category', { length: 50 }).notNull(),
    action: varchar('action', { length: 100 }).notNull(),
    label: varchar('label', { length: 200 }),
    value: decimal('value', { precision: 14, scale: 4 }),

    // Context
    screen: varchar('screen', { length: 100 }),
    appVersion: varchar('app_version', { length: 20 }),
    platform: varchar('platform', { length: 10 }),
    deviceModel: varchar('device_model', { length: 100 }),

    // Pre-computed YYYY-MM-DD bucket
    yearMonthDay: varchar('year_month_day', { length: 10 }).notNull(),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantDateIdx: index('idx_app_events_tenant_date').on(t.tenantId, t.yearMonthDay),
    userDateIdx: index('idx_app_events_user_date').on(t.userId, t.yearMonthDay),
    eventTypeIdx: index('idx_app_events_type').on(t.eventType),
    actionIdx: index('idx_app_events_action').on(t.category, t.action),
  }),
);

export type AppUsageEventRow = typeof appUsageEvents.$inferSelect;
export type NewAppUsageEvent = typeof appUsageEvents.$inferInsert;
