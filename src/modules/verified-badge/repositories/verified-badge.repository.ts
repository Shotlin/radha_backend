import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { tenants, type TenantRow } from '@/db/schema/tenants';
import {
  verifiedBadges,
  type NewVerifiedBadge,
  type VerifiedBadgeRow,
} from '@/db/schema/verified-badges';

/**
 * BE-52 — `radha_verified_badges` data access.
 *
 * The cron writes through `upsertIssue()` / `markRevoked()`, both
 * idempotent on `tenant_id` (UNIQUE). The HTTP endpoints read via
 * `findByTenantId` and `findIssuedTenantBySlug`.
 *
 * Tenant lookup is bundled here (single repository) because the
 * verify endpoint joins on `tenants.slug` once — splitting it into
 * its own repo would add a Nest provider with no extra reuse.
 */
@Injectable()
export class VerifiedBadgeRepository {
  constructor(private readonly db: DbService) {}

  async findByTenantId(tenantId: string): Promise<VerifiedBadgeRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(verifiedBadges)
      .where(eq(verifiedBadges.tenantId, tenantId))
      .limit(1);
    return (rows[0] as VerifiedBadgeRow | undefined) ?? null;
  }

  async findTenantBySlug(slug: string): Promise<TenantRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    return (rows[0] as TenantRow | undefined) ?? null;
  }

  /**
   * Upsert an `issued` badge for the tenant.
   *
   * - First-time issuance: inserts the row.
   * - Re-issuance after revocation: flips `status` back to
   *   `'issued'`, refreshes `issued_at`, clears `revoked_at` /
   *   `revoked_reason`, and stores the latest score.
   *
   * Returns the persisted row.
   */
  async upsertIssue(input: {
    tenantId: string;
    issuedAt: Date;
    lastScore: number;
  }): Promise<VerifiedBadgeRow> {
    const values: NewVerifiedBadge = {
      tenantId: input.tenantId,
      status: 'issued',
      issuedAt: input.issuedAt,
      lastScore: input.lastScore.toFixed(2),
      revokedAt: null,
      revokedReason: null,
    };

    const rows = await this.db
      .getDb()
      .insert(verifiedBadges)
      .values(values)
      .onConflictDoUpdate({
        target: verifiedBadges.tenantId,
        set: {
          status: 'issued',
          issuedAt: input.issuedAt,
          lastScore: input.lastScore.toFixed(2),
          revokedAt: null,
          revokedReason: null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return rows[0] as VerifiedBadgeRow;
  }

  /**
   * Flip an existing issued row to `revoked`. Returns `null` if no
   * row exists for the tenant — revocation of a non-existent badge
   * is a no-op (the cron passes through this branch when the badge
   * was already revoked or never issued).
   */
  async markRevoked(input: {
    tenantId: string;
    revokedAt: Date;
    reason: string;
  }): Promise<VerifiedBadgeRow | null> {
    const rows = await this.db
      .getDb()
      .update(verifiedBadges)
      .set({
        status: 'revoked',
        revokedAt: input.revokedAt,
        revokedReason: input.reason,
        updatedAt: sql`now()`,
      })
      .where(eq(verifiedBadges.tenantId, input.tenantId))
      .returning();
    return (rows[0] as VerifiedBadgeRow | undefined) ?? null;
  }
}
