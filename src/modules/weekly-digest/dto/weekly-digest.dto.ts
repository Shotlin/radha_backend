import { z } from 'zod';

/**
 * BE-54 — DTOs and Zod schemas for the weekly digest module.
 *
 * The payload shape is a flat snapshot — we deliberately keep it
 * tight so the JSON column stays small and renders cheaply on the
 * Mobile_App. Top products and savings ship empty in v1; the
 * adapter will start populating them once BE-29 analytics rollups
 * land.
 */

export const weeklyDigestTopProductSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  ean: z.string().min(1).max(13).optional(),
  productName: z.string().min(1).max(200),
  scans: z.number().int().nonnegative(),
});

export type WeeklyDigestTopProduct = z.infer<typeof weeklyDigestTopProductSchema>;

export const weeklyDigestPayloadSchema = z.object({
  scansCount: z.number().int().nonnegative(),
  highSugarCount: z.number().int().nonnegative(),
  recallCount: z.number().int().nonnegative(),
  alternativesRecommended: z.number().int().nonnegative(),
  topProducts: z.array(weeklyDigestTopProductSchema).default([]),
  savings: z.number().nonnegative().default(0),
});

export type WeeklyDigestPayload = z.infer<typeof weeklyDigestPayloadSchema>;

/**
 * Result envelope returned by the cron after one full sweep.
 */
export interface WeeklyDigestRunReport {
  /** Number of consumers considered for the week. */
  consumersScanned: number;
  /** Rows inserted this run. */
  digestsCreated: number;
  /** Users whose row already existed (idempotent skip). */
  idempotentSkips: number;
  /** Users opted out of the `daily-insights` category. */
  optedOutSkips: number;
  /** Successful FCM sends (delivered_at stamped). */
  notificationsDelivered: number;
  /** Failed FCM sends (delivered_at left null). */
  notificationsFailed: number;
  /** Total duration in milliseconds. */
  durationMs: number;
}

/**
 * Per-user input for the digest service. Stays narrow so the
 * service can remain unaware of how the cron paginates consumers.
 */
export interface ConsumerForDigest {
  userId: string;
  tenantId: string | null;
  preferredLanguage?: string;
}

/**
 * Wire contract for `GET /weekly-digest` — consumed by the
 * Mobile_App "Your week with RADHA" screen (`WeeklyDigestResponse`
 * on the Flutter side). Counters the backend doesn't track yet stay
 * zero / empty rather than being omitted, so the client never has to
 * guess at a missing field.
 */
export interface WeeklyDigestTopCategoryDto {
  category: string;
  count: number;
}

export interface WeeklyDigestResponseDto {
  weekStartDate: string;
  weekEndDate: string;
  scansCount: number;
  savedProductsCount: number;
  expiringSoonCount: number;
  recallAlertsCount: number;
  estimatedSavingsInr: number;
  topCategories: WeeklyDigestTopCategoryDto[];
  healthHighlights: string[];
}
