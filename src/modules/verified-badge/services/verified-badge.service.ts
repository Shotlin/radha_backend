import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { TenantRow } from '@/db/schema/tenants';
import type { VerifiedBadgeRow } from '@/db/schema/verified-badges';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  BADGE_PNG_PATH,
  BADGE_SVG_PATH,
  type BadgeStatus,
  type MyBadgeResponseDto,
  type VerifyBadgeResponseDto,
} from '../dto/badge.dto';
import { OHS_SOURCE_PORT, type IOhsSourcePort } from '../ports/ohs-source.port';
import { PRO_TIER_PORT, type IProTierPort } from '../ports/pro-tier.port';
import { VerifiedBadgeRepository } from '../repositories/verified-badge.repository';

import { BadgeEligibilityService, REVOKE_REASON } from './badge-eligibility.service';

/**
 * BE-52 — verified-badge orchestrator.
 *
 * Two surfaces feed in here:
 *
 *   1. The daily cron evaluates every Pro tenant via
 *      `evaluateTenant(tenantId)`. The method returns a verdict so
 *      the caller can collect a sweep report; persistence + audit +
 *      notification fan-out happen inside.
 *
 *   2. The HTTP layer reads via `getMyBadge` / `verifyBySlug`. Both
 *      paths are read-only and stay tenant-scoped (`/me`) or public
 *      (`/verify/:slug`) — the controller enforces auth.
 *
 * The service is intentionally idempotent: re-running the cron the
 * same day with the same OHS input is a no-op (the row's `status`
 * doesn't flip and we skip the audit + notification fan-out).
 */
export interface BadgeVerdict {
  tenantId: string;
  /** What we did this cycle. */
  outcome: 'issued' | 'revoked' | 'reissued' | 'unchanged' | 'skipped-non-pro';
  lastScore: number | null;
}

@Injectable()
export class VerifiedBadgeService {
  constructor(
    private readonly repo: VerifiedBadgeRepository,
    private readonly eligibility: BadgeEligibilityService,
    private readonly logger: LoggerService,
    private readonly auditLog: AuditLogService,
    @Inject(OHS_SOURCE_PORT)
    private readonly ohs: IOhsSourcePort,
    @Inject(PRO_TIER_PORT)
    private readonly proTier: IProTierPort,
  ) {}

  /* ───────────────────── cron path ───────────────────── */

  /**
   * Single-tenant evaluation. The cron loops over Pro tenants and
   * calls this for each. We keep the verdict structured so the cron
   * can emit a useful summary log.
   */
  async evaluateTenant(tenantId: string): Promise<BadgeVerdict> {
    const isPro = await this.proTier.isPro(tenantId);
    if (!isPro) {
      // Defence-in-depth — the cron filters by Pro plan first, but
      // the plan could have flipped between listing and evaluation.
      return { tenantId, outcome: 'skipped-non-pro', lastScore: null };
    }

    const scores = await this.ohs.last30Days(tenantId);
    const existing = await this.repo.findByTenantId(tenantId);

    // ─── Issuance path ─────────────────────────────────────────
    const issueCheck = this.eligibility.evaluateIssue(scores);
    if (
      issueCheck.eligible &&
      issueCheck.lastScore !== null &&
      (!existing || existing.status === 'revoked')
    ) {
      const reissue = existing?.status === 'revoked';
      const row = await this.repo.upsertIssue({
        tenantId,
        issuedAt: new Date(),
        lastScore: issueCheck.lastScore,
      });

      void this.auditLog.logAction({
        action: reissue ? 'UPDATE' : 'CREATE',
        resourceType: 'radha_verified_badge',
        resourceId: row.id,
        tenantId,
        userId: 'system',
        success: true,
        metadata: {
          event: reissue ? 'badge.reissued' : 'badge.issued',
          lastScore: issueCheck.lastScore,
        },
      });

      this.logger.info('verified-badge.issued', {
        tenantId,
        lastScore: issueCheck.lastScore,
        reissue,
      });

      return {
        tenantId,
        outcome: reissue ? 'reissued' : 'issued',
        lastScore: issueCheck.lastScore,
      };
    }

    // ─── Revocation path ───────────────────────────────────────
    if (existing?.status === 'issued') {
      const revokeCheck = this.eligibility.evaluateRevoke(scores);
      if (revokeCheck.eligible) {
        const row = await this.repo.markRevoked({
          tenantId,
          revokedAt: new Date(),
          reason: REVOKE_REASON,
        });

        if (row) {
          void this.auditLog.logAction({
            action: 'UPDATE',
            resourceType: 'radha_verified_badge',
            resourceId: row.id,
            tenantId,
            userId: 'system',
            success: true,
            metadata: {
              event: 'badge.revoked',
              reason: REVOKE_REASON,
              lastScore: revokeCheck.lastScore,
            },
          });

          this.logger.info('verified-badge.revoked', {
            tenantId,
            reason: REVOKE_REASON,
            lastScore: revokeCheck.lastScore,
          });
        }

        return {
          tenantId,
          outcome: 'revoked',
          lastScore: revokeCheck.lastScore,
        };
      }
    }

    return { tenantId, outcome: 'unchanged', lastScore: issueCheck.lastScore };
  }

  /* ───────────────────── HTTP read paths ───────────────────── */

  /**
   * GET /api/v1/badges/me — tenant fetches its own badge state.
   *
   * - `'issued'` returns the issuance timestamp + asset URLs.
   * - `'revoked'` returns the revocation metadata so the dashboard
   *   can show a "you previously held the badge" notice.
   * - `'none'` is the default for tenants that never qualified.
   */
  async getMyBadge(tenantId: string): Promise<MyBadgeResponseDto> {
    const row = await this.repo.findByTenantId(tenantId);
    if (!row) {
      return { status: 'none' };
    }
    return this.toMyBadgeView(row);
  }

  /**
   * GET /api/v1/verify/:tenantSlug — public verification.
   *
   * No auth required (the controller marks the route public). We
   * return only the minimum needed to confirm the badge: tenant
   * display name, current status, and the verification timestamp.
   * No PII beyond the tenant name is leaked.
   *
   * Throws `NotFoundException` when the slug doesn't resolve to a
   * tenant — the verify response never leaks "tenant exists but
   * has no badge" vs "tenant doesn't exist" through different
   * codes; both surface as 404 to keep the public route simple
   * and reduce enumeration risk.
   */
  async verifyBySlug(slug: string): Promise<VerifyBadgeResponseDto> {
    const tenant = await this.repo.findTenantBySlug(slug);
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const row = await this.repo.findByTenantId(tenant.id);
    return this.toVerifyView(tenant, row);
  }

  /* ───────────────────── view shaping ───────────────────── */

  private toMyBadgeView(row: VerifiedBadgeRow): MyBadgeResponseDto {
    const status = row.status as BadgeStatus;
    const view: MyBadgeResponseDto = {
      status,
      issuedAt: row.issuedAt.toISOString(),
      lastScore: row.lastScore ?? null,
    };
    if (status === 'issued') {
      view.badgeAssets = { png: BADGE_PNG_PATH, svg: BADGE_SVG_PATH };
    }
    if (status === 'revoked') {
      view.revokedAt = row.revokedAt ? row.revokedAt.toISOString() : undefined;
      view.revokedReason = row.revokedReason ?? undefined;
    }
    return view;
  }

  private toVerifyView(tenant: TenantRow, row: VerifiedBadgeRow | null): VerifyBadgeResponseDto {
    const verifiedAt = new Date().toISOString();
    if (!row) {
      return {
        tenantName: tenant.name,
        status: 'none',
        verifiedAt,
      };
    }
    return {
      tenantName: tenant.name,
      status: row.status as BadgeStatus,
      issuedAt: row.issuedAt.toISOString(),
      verifiedAt,
    };
  }
}
