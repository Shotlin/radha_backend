import { index, jsonb, pgEnum, pgTable, varchar } from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-29 — Marketing website events.
 *
 * Privacy notes:
 *   - No raw IP addresses are stored. Visitors are identified only by
 *     `visitorIdHash` (SHA-256 of session cookie + ANALYTICS_HASH_SALT)
 *     so an attacker with read access to this table cannot derive the
 *     original cookie or correlate to a specific person.
 *   - Geo is country-only (ISO-3166 alpha-2). No city, no precise
 *     coordinates.
 *   - `metadata` is run through `redactPII` at the service layer
 *     before insert.
 *
 * `tenantId` is intentionally absent — the marketing site has no
 * authenticated tenant context. Aggregations join through UTM and the
 * `marketing_leads` conversion link instead.
 */

export const websiteEventTypeEnum = pgEnum('website_event_type', [
  'page_view',
  'button_click',
  'pricing_view',
  'demo_click',
  'contact_click',
  'whatsapp_click',
  'app_download_click',
  'feature_view',
  'scroll_depth',
  'video_play',
  'form_submit',
]);

export const websiteEvents = pgTable(
  'website_events',
  {
    ...baseColumns,
    type: websiteEventTypeEnum('type').notNull(),

    // Page context
    page: varchar('page', { length: 500 }),
    pageTitle: varchar('page_title', { length: 200 }),
    referrer: varchar('referrer', { length: 500 }),

    // UTM (campaign attribution)
    utmSource: varchar('utm_source', { length: 100 }),
    utmMedium: varchar('utm_medium', { length: 100 }),
    utmCampaign: varchar('utm_campaign', { length: 200 }),
    utmTerm: varchar('utm_term', { length: 200 }),
    utmContent: varchar('utm_content', { length: 200 }),

    // Tech (anonymized — coarse buckets only)
    userAgent: varchar('user_agent', { length: 500 }),
    browser: varchar('browser', { length: 50 }),
    os: varchar('os', { length: 50 }),
    device: varchar('device', { length: 30 }),

    // Geo — country-level only for privacy
    country: varchar('country', { length: 2 }),

    // Session (hashed)
    sessionId: varchar('session_id', { length: 64 }),
    visitorIdHash: varchar('visitor_id_hash', { length: 64 }),

    // Pre-computed YYYY-MM-DD bucket for cheap aggregation
    yearMonthDay: varchar('year_month_day', { length: 10 }).notNull(),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    typeDateIdx: index('idx_website_events_type_date').on(t.type, t.yearMonthDay),
    sessionIdx: index('idx_website_events_session').on(t.sessionId),
    visitorIdx: index('idx_website_events_visitor').on(t.visitorIdHash),
    utmCampaignIdx: index('idx_website_events_utm_campaign').on(t.utmCampaign),
    dateIdx: index('idx_website_events_date').on(t.yearMonthDay),
  }),
);

export type WebsiteEventRow = typeof websiteEvents.$inferSelect;
export type NewWebsiteEvent = typeof websiteEvents.$inferInsert;
