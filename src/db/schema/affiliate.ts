import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { baseColumns } from './_base';

/**
 * BE-41 — Healthy Alternatives + Affiliate Engine.
 *
 * Three tables:
 *   - `affiliate_partners`  : registered partners (Amazon, Flipkart, …) with
 *                             link templates and per-partner affiliate ids.
 *   - `affiliate_clicks`    : outbound click log (no PII — only user_id ref).
 *   - `affiliate_revenue`   : webhook-reported revenue, optionally attributed
 *                             to a click for conversion tracking.
 *
 * Tables are NOT tenant-scoped. Partners are platform-wide, and clicks
 * are tracked at the user level for the consumer-facing product
 * (alternatives recommendation is a Premium consumer feature).
 */

export const affiliatePartners = pgTable(
  'affiliate_partners',
  {
    ...baseColumns,
    name: text('name').notNull(),
    affiliateId: text('affiliate_id').notNull(),
    /**
     * Click-out link template with `{ean}` and `{affiliateId}` placeholders.
     * Example: `https://www.amazon.in/dp/{ean}?tag={affiliateId}`
     */
    linkTemplate: text('link_template').notNull(),
    /**
     * Optional shared secret used to verify HMAC-SHA256 signatures on
     * partner-reported revenue webhooks. Nullable: a partner that has
     * not yet onboarded a webhook can still be used for click-out
     * link generation. The revenue endpoint refuses webhooks for
     * partners whose secret is null.
     */
    hmacSecret: text('hmac_secret'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => ({
    nameUnique: uniqueIndex('affiliate_partners_name_unique').on(t.name),
    activeIdx: index('affiliate_partners_active_idx').on(t.isActive),
  }),
);

export type AffiliatePartnerRow = typeof affiliatePartners.$inferSelect;
export type NewAffiliatePartner = typeof affiliatePartners.$inferInsert;

export const affiliateClicks = pgTable(
  'affiliate_clicks',
  {
    ...baseColumns,
    /** Nullable so anonymised clicks remain queryable after user deletion. */
    userId: uuid('user_id'),
    sourceProductEan: text('source_product_ean').notNull(),
    alternativeProductEan: text('alternative_product_ean').notNull(),
    partnerId: uuid('partner_id').notNull(),
    clickedAt: timestamp('clicked_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    partnerIdx: index('affiliate_clicks_partner_idx').on(t.partnerId),
    userIdx: index('affiliate_clicks_user_idx').on(t.userId),
    clickedAtIdx: index('affiliate_clicks_clicked_at_idx').on(t.clickedAt),
    sourceEanIdx: index('affiliate_clicks_source_ean_idx').on(t.sourceProductEan),
  }),
);

export type AffiliateClickRow = typeof affiliateClicks.$inferSelect;
export type NewAffiliateClick = typeof affiliateClicks.$inferInsert;

export const affiliateRevenue = pgTable(
  'affiliate_revenue',
  {
    ...baseColumns,
    partnerId: uuid('partner_id').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    /** Optional FK to the click that produced the conversion. */
    attributedClickId: uuid('attributed_click_id'),
    reportedAt: timestamp('reported_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    partnerIdx: index('affiliate_revenue_partner_idx').on(t.partnerId),
    reportedAtIdx: index('affiliate_revenue_reported_at_idx').on(t.reportedAt),
    clickIdx: index('affiliate_revenue_click_idx').on(t.attributedClickId),
  }),
);

export type AffiliateRevenueRow = typeof affiliateRevenue.$inferSelect;
export type NewAffiliateRevenue = typeof affiliateRevenue.$inferInsert;
