import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { baseColumns, softDeleteColumn, tenantScopeColumn } from './_base';

/**
 * BE-37 — Allergen profiles (per-family-member).
 *
 * Each consumer can maintain allergen profiles for themselves and
 * family members. Free tier = 1 profile, Premium = 5 profiles.
 *
 * `display_name_encrypted` stores the AES-256 envelope-encrypted
 * display name (BYTEA in Postgres, Buffer in Node).
 *
 * RLS policy `allergen_tenant_isolation` enforces tenant scoping
 * at the database layer.
 */

export const ageBandValues = [
  'infant',
  'toddler',
  'child',
  'adolescent',
  'adult',
  'senior',
] as const;
export type AgeBand = (typeof ageBandValues)[number];

export const allergenProfiles = pgTable(
  'allergen_profiles',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...tenantScopeColumn,

    userId: uuid('user_id').notNull(),
    familyMemberUserId: uuid('family_member_user_id'),

    /** AES-256 envelope-encrypted display name (BYTEA). */
    displayNameEncrypted: text('display_name_encrypted').notNull(),

    ageBand: text('age_band').notNull(),

    allergyTags: text('allergy_tags')
      .array()
      .notNull()
      .default(sql`'{}'`),

    conditionTags: text('condition_tags')
      .array()
      .notNull()
      .default(sql`'{}'`),

    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => ({
    tenantUserIdx: index('idx_allergen_profiles_tenant_user').on(t.tenantId, t.userId),
    userActiveIdx: index('idx_allergen_profiles_user_active').on(t.userId, t.isActive),
    familyMemberIdx: index('idx_allergen_profiles_family_member').on(t.familyMemberUserId),
  }),
);

export type AllergenProfileRow = typeof allergenProfiles.$inferSelect;
export type NewAllergenProfile = typeof allergenProfiles.$inferInsert;
