import { index, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * BE-29 — Marketing leads (contact / demo / whatsapp inbound).
 *
 * One row per inbound contact. Status transitions
 * (new → contacted → qualified → demo_scheduled → demo_completed →
 * converted | lost | spam) are audit-logged at the service layer.
 *
 * `convertedTenantId` links the lead to the BE-09 tenant created
 * after conversion, closing the marketing-funnel loop.
 *
 * PII handling:
 *   - `mobile`, `email`, `name` are required for legitimate follow-up
 *     and stored as-is (the lead consents by submitting the form).
 *   - The redaction layer in logs/audit makes sure they never appear
 *     in stdout.
 *   - `metadata` is run through `redactPII` before insert so any
 *     extra fields the form happens to submit don't accidentally
 *     contain Aadhaar / PAN / card numbers.
 */

export const leadSourceEnum = pgEnum('lead_source', [
  'contact_form',
  'demo_request',
  'whatsapp',
  'phone',
  'email',
  'referral',
  'other',
]);

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'contacted',
  'qualified',
  'demo_scheduled',
  'demo_completed',
  'converted',
  'lost',
  'spam',
]);

export const marketingLeads = pgTable(
  'marketing_leads',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,

    // Contact info
    name: varchar('name', { length: 100 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    mobile: varchar('mobile', { length: 20 }),
    company: varchar('company', { length: 200 }),
    message: varchar('message', { length: 2000 }),

    // Classification
    source: leadSourceEnum('source').notNull(),
    status: leadStatusEnum('status').notNull().default('new'),

    // UTM
    utmSource: varchar('utm_source', { length: 100 }),
    utmMedium: varchar('utm_medium', { length: 100 }),
    utmCampaign: varchar('utm_campaign', { length: 200 }),

    // Context
    pageUrl: varchar('page_url', { length: 500 }),
    referrer: varchar('referrer', { length: 500 }),

    // Lifecycle timestamps + actors
    contactedAt: timestamp('contacted_at', { withTimezone: true }),
    contactedBy: uuid('contacted_by'),
    demoScheduledAt: timestamp('demo_scheduled_at', { withTimezone: true }),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    convertedTenantId: uuid('converted_tenant_id'),
    lostAt: timestamp('lost_at', { withTimezone: true }),
    lostReason: varchar('lost_reason', { length: 500 }),

    // Internal
    notes: varchar('notes', { length: 2000 }),
    assignedTo: uuid('assigned_to'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    statusIdx: index('idx_leads_status').on(t.status),
    sourceIdx: index('idx_leads_source').on(t.source),
    emailIdx: index('idx_leads_email').on(t.email),
    convertedIdx: index('idx_leads_converted').on(t.convertedTenantId),
    createdIdx: index('idx_leads_created').on(t.createdAt),
  }),
);

export type MarketingLeadRow = typeof marketingLeads.$inferSelect;
export type NewMarketingLead = typeof marketingLeads.$inferInsert;
