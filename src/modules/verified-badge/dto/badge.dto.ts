import { z } from 'zod';

/**
 * BE-52 — Request/response DTOs for the verified-badge HTTP surface.
 *
 * The two endpoints both return JSON; only the public `/verify/:slug`
 * route accepts a path parameter that needs schema validation.
 */

export const VerifyBadgeParamSchema = z
  .object({
    tenantSlug: z
      .string()
      .min(1)
      .max(120)
      // Slugs are kebab-case ASCII; reject any path segment that could
      // otherwise be used to traverse routes or smuggle whitespace.
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Invalid tenant slug'),
  })
  .strict();

export type VerifyBadgeParamDto = z.infer<typeof VerifyBadgeParamSchema>;

/** "issued" / "revoked" mirrors `radha_verified_badges.status`. "none" surfaces missing rows. */
export type BadgeStatus = 'issued' | 'revoked' | 'none';

export interface BadgeAssetsDto {
  /** Static asset path served by the platform CDN; populated only when status === 'issued'. */
  png: string;
  /** SVG counterpart for embedding in marketing/owner-dashboard surfaces. */
  svg: string;
}

export interface MyBadgeResponseDto {
  status: BadgeStatus;
  /** ISO 8601 timestamp; omitted when no badge has ever been issued. */
  issuedAt?: string;
  /** Last OHS total observed at issuance; numeric (5,2) → string preserves precision. */
  lastScore?: string | null;
  /** Set when status === 'revoked'. */
  revokedAt?: string;
  /** Human-readable reason aligned with the cron's metadata (e.g. 'OHS below 70 for 7 days'). */
  revokedReason?: string;
  /** Public asset URLs the Mobile_App / Owner_Dashboard can render. */
  badgeAssets?: BadgeAssetsDto;
}

export interface VerifyBadgeResponseDto {
  /** Tenant display name — public verification surface, no PII beyond what marketing already exposes. */
  tenantName: string;
  /** "issued" → currently valid, "revoked" → previously held, "none" → never earned. */
  status: BadgeStatus;
  issuedAt?: string;
  /** ISO 8601 timestamp of *this* verification request. Useful for audit-able receipts. */
  verifiedAt: string;
}

/**
 * Asset path constants. The CDN path itself is out of scope for
 * BE-52 — we just hand the client a static URL prefix and let the
 * marketing / app-dashboard infra serve the file.
 */
export const BADGE_PNG_PATH = '/static/badges/radha-verified.png';
export const BADGE_SVG_PATH = '/static/badges/radha-verified.svg';
