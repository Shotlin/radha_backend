import { NotFoundException } from '@nestjs/common';

import type { TenantRow } from '@/db/schema/tenants';
import type { VerifiedBadgeRow } from '@/db/schema/verified-badges';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { BADGE_PNG_PATH, BADGE_SVG_PATH } from '../dto/badge.dto';
import type { IOhsSourcePort, OhsScoreEntry } from '../ports/ohs-source.port';
import type { IProTierPort } from '../ports/pro-tier.port';
import { VerifiedBadgeRepository } from '../repositories/verified-badge.repository';
import { BadgeEligibilityService, REVOKE_REASON } from '../services/badge-eligibility.service';
import { VerifiedBadgeService } from '../services/verified-badge.service';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  }) as unknown as LoggerService;

const buildAuditLog = (): AuditLogService =>
  ({
    logAction: jest.fn().mockResolvedValue(undefined),
    logBatch: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  }) as unknown as AuditLogService;

const buildRepo = () =>
  ({
    findByTenantId: jest.fn(),
    findTenantBySlug: jest.fn(),
    upsertIssue: jest.fn(),
    markRevoked: jest.fn(),
  }) as unknown as VerifiedBadgeRepository & {
    findByTenantId: jest.Mock;
    findTenantBySlug: jest.Mock;
    upsertIssue: jest.Mock;
    markRevoked: jest.Mock;
  };

const buildOhs = (scores: OhsScoreEntry[]): IOhsSourcePort => ({
  last30Days: jest.fn().mockResolvedValue(scores),
});

const buildProTier = (isPro = true): IProTierPort => ({
  listProTenantIds: jest.fn().mockResolvedValue([]),
  isPro: jest.fn().mockResolvedValue(isPro),
});

const day = (i: number, total: number): OhsScoreEntry => {
  const d = new Date('2025-01-01T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  return { date: d.toISOString().slice(0, 10), total };
};

const eligibleScores = (): OhsScoreEntry[] => Array.from({ length: 30 }, (_, i) => day(i, 80));

const failingScores = (): OhsScoreEntry[] => {
  const s = Array.from({ length: 30 }, (_, i) => day(i, 80));
  for (let i = 23; i < 30; i += 1) s[i] = day(i, 50);
  return s;
};

const issuedRow = (overrides: Partial<VerifiedBadgeRow> = {}): VerifiedBadgeRow =>
  ({
    id: 'badge-1',
    tenantId: 't1',
    status: 'issued',
    issuedAt: new Date('2025-02-01T03:00:00Z'),
    lastScore: '80.00',
    revokedAt: null,
    revokedReason: null,
    createdAt: new Date('2025-02-01T03:00:00Z'),
    updatedAt: new Date('2025-02-01T03:00:00Z'),
    ...overrides,
  }) as VerifiedBadgeRow;

const tenantRow = (overrides: Partial<TenantRow> = {}): TenantRow =>
  ({
    id: 't1',
    name: 'Acme Stores',
    slug: 'acme-stores',
    ...overrides,
  }) as unknown as TenantRow;

describe('VerifiedBadgeService', () => {
  describe('evaluateTenant — issuance', () => {
    it('issues a new badge when the 30-day eligibility check passes', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(null);
      repo.upsertIssue.mockResolvedValue(issuedRow({ lastScore: '80.00' }));

      const audit = buildAuditLog();
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        audit,
        buildOhs(eligibleScores()),
        buildProTier(true),
      );

      const verdict = await svc.evaluateTenant('t1');
      expect(verdict.outcome).toBe('issued');
      expect(verdict.lastScore).toBe(80);
      expect(repo.upsertIssue).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't1', lastScore: 80 }),
      );
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'radha_verified_badge',
          metadata: expect.objectContaining({ event: 'badge.issued' }),
        }),
      );
    });

    it('does NOT issue when the tenant is not on the Pro tier', async () => {
      const repo = buildRepo();
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs(eligibleScores()),
        buildProTier(false),
      );

      const verdict = await svc.evaluateTenant('t1');
      expect(verdict.outcome).toBe('skipped-non-pro');
      expect(repo.findByTenantId).not.toHaveBeenCalled();
      expect(repo.upsertIssue).not.toHaveBeenCalled();
    });

    it('is idempotent — re-evaluation while the badge is already issued is a no-op', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(issuedRow());

      const audit = buildAuditLog();
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        audit,
        buildOhs(eligibleScores()),
        buildProTier(true),
      );

      const verdict = await svc.evaluateTenant('t1');
      expect(verdict.outcome).toBe('unchanged');
      expect(repo.upsertIssue).not.toHaveBeenCalled();
      expect(repo.markRevoked).not.toHaveBeenCalled();
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('re-issues a previously revoked badge once eligibility recovers', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(
        issuedRow({
          status: 'revoked',
          revokedAt: new Date('2025-01-15T03:00:00Z'),
          revokedReason: REVOKE_REASON,
        }),
      );
      repo.upsertIssue.mockResolvedValue(issuedRow({ lastScore: '80.00' }));

      const audit = buildAuditLog();
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        audit,
        buildOhs(eligibleScores()),
        buildProTier(true),
      );

      const verdict = await svc.evaluateTenant('t1');
      expect(verdict.outcome).toBe('reissued');
      expect(repo.upsertIssue).toHaveBeenCalled();
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          metadata: expect.objectContaining({ event: 'badge.reissued' }),
        }),
      );
    });
  });

  describe('evaluateTenant — revocation', () => {
    it('revokes an issued badge when 7 consecutive days drop below 70', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(issuedRow());
      repo.markRevoked.mockResolvedValue(
        issuedRow({
          status: 'revoked',
          revokedAt: new Date('2025-02-08T03:00:00Z'),
          revokedReason: REVOKE_REASON,
        }),
      );

      const audit = buildAuditLog();
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        audit,
        buildOhs(failingScores()),
        buildProTier(true),
      );

      const verdict = await svc.evaluateTenant('t1');
      expect(verdict.outcome).toBe('revoked');
      expect(repo.markRevoked).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't1', reason: REVOKE_REASON }),
      );
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            event: 'badge.revoked',
            reason: REVOKE_REASON,
          }),
        }),
      );
    });

    it('does NOT revoke a badge that is already in the revoked state', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(
        issuedRow({
          status: 'revoked',
          revokedAt: new Date('2025-01-15T03:00:00Z'),
          revokedReason: REVOKE_REASON,
        }),
      );

      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs(failingScores()),
        buildProTier(true),
      );

      const verdict = await svc.evaluateTenant('t1');
      expect(verdict.outcome).toBe('unchanged');
      expect(repo.markRevoked).not.toHaveBeenCalled();
    });
  });

  describe('getMyBadge', () => {
    it('returns "none" when no badge row exists for the tenant', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(null);
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs([]),
        buildProTier(),
      );

      const result = await svc.getMyBadge('t1');
      expect(result.status).toBe('none');
      expect(result.badgeAssets).toBeUndefined();
    });

    it('exposes badge asset URLs only when the status is "issued"', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(issuedRow());
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs([]),
        buildProTier(),
      );

      const result = await svc.getMyBadge('t1');
      expect(result.status).toBe('issued');
      expect(result.badgeAssets).toEqual({
        png: BADGE_PNG_PATH,
        svg: BADGE_SVG_PATH,
      });
    });

    it('surfaces revocation metadata for a revoked badge', async () => {
      const repo = buildRepo();
      repo.findByTenantId.mockResolvedValue(
        issuedRow({
          status: 'revoked',
          revokedAt: new Date('2025-02-08T03:00:00Z'),
          revokedReason: REVOKE_REASON,
        }),
      );
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs([]),
        buildProTier(),
      );

      const result = await svc.getMyBadge('t1');
      expect(result.status).toBe('revoked');
      expect(result.revokedReason).toBe(REVOKE_REASON);
      expect(result.badgeAssets).toBeUndefined();
    });
  });

  describe('verifyBySlug', () => {
    it('throws NotFound when the slug does not resolve to a tenant', async () => {
      const repo = buildRepo();
      repo.findTenantBySlug.mockResolvedValue(null);
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs([]),
        buildProTier(),
      );

      await expect(svc.verifyBySlug('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns "none" status for a tenant that has never earned a badge', async () => {
      const repo = buildRepo();
      repo.findTenantBySlug.mockResolvedValue(tenantRow());
      repo.findByTenantId.mockResolvedValue(null);
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs([]),
        buildProTier(),
      );

      const result = await svc.verifyBySlug('acme-stores');
      expect(result.tenantName).toBe('Acme Stores');
      expect(result.status).toBe('none');
      expect(result.verifiedAt).toEqual(expect.any(String));
    });

    it('returns issued status + tenant name for a publicly verifiable tenant', async () => {
      const repo = buildRepo();
      repo.findTenantBySlug.mockResolvedValue(tenantRow());
      repo.findByTenantId.mockResolvedValue(issuedRow());
      const svc = new VerifiedBadgeService(
        repo,
        new BadgeEligibilityService(),
        buildLogger(),
        buildAuditLog(),
        buildOhs([]),
        buildProTier(),
      );

      const result = await svc.verifyBySlug('acme-stores');
      expect(result.status).toBe('issued');
      expect(result.tenantName).toBe('Acme Stores');
      expect(result.issuedAt).toEqual(expect.any(String));
    });
  });
});
