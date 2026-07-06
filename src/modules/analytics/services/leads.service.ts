import { Inject, Injectable, Optional } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import { redactPII } from '@/common/utils/redact.utils';
import { ConfigService } from '@/config/config.service';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AUDIT_LOG_SERVICE, type IAuditLogService } from '@/observability/audit-log.types';

import { MarketingLeadsRepository } from '../repositories/marketing-leads.repository';
import type { DateRange } from '../types/analytics.types';
import type {
  ConversionStats,
  CreateLeadInput,
  ILeadsService,
  LeadStatus,
  ListLeadsFilter,
  MarketingLead,
} from '../types/lead.types';

/**
 * BE-29 — Lead management.
 *
 *   - Spam detection at create time (basic: domain blocklist + content
 *     heuristics + duplicate-window). Spammy leads are recorded with
 *     status='spam' and never trigger an owner notification.
 *   - Owner notification fires through `NotificationsService` (BE-24)
 *     for the `new-lead` template the orchestrator will register. We
 *     guard with `OWNER_EMAIL` from `process.env` — when unset,
 *     creation still succeeds, just without the email fan-out.
 *   - Audit log on **status changes only** (not on every create —
 *     too noisy at marketing scale).
 */
const RESOURCE = 'marketing_lead';
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SPAM_PATTERNS: RegExp[] = [
  /buy.{0,5}viagra/i,
  /click.{0,5}here/i,
  /free.{0,5}money/i,
  /\b(?:btc|crypto)\s+investment\b/i,
  /\b(?:loan|credit).{0,10}guaranteed/i,
];
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  'guerrillamail.com',
  '10minutemail.com',
  'throwawaymail.com',
]);

@Injectable()
export class LeadsService implements ILeadsService {
  constructor(
    private readonly repo: MarketingLeadsRepository,
    private readonly config: ConfigService,
    private readonly appLogger: LoggerService,
    @Inject(AUDIT_LOG_SERVICE) private readonly auditLog: IAuditLogService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  async createLead(input: CreateLeadInput): Promise<MarketingLead> {
    const isSpam = await this.classifySpam(input);

    const metadata = input.metadata ? (redactPII(input.metadata) as Record<string, unknown>) : {};

    const lead = await this.repo.create({
      name: input.name.slice(0, 100),
      email: input.email.toLowerCase().slice(0, 255),
      mobile: input.mobile?.slice(0, 20) ?? null,
      company: input.company?.slice(0, 200) ?? null,
      message: input.message?.slice(0, 2000) ?? null,
      source: input.source,
      status: isSpam ? 'spam' : 'new',
      utmSource: input.utmSource?.slice(0, 100) ?? null,
      utmMedium: input.utmMedium?.slice(0, 100) ?? null,
      utmCampaign: input.utmCampaign?.slice(0, 200) ?? null,
      pageUrl: input.pageUrl?.slice(0, 500) ?? null,
      referrer: input.referrer?.slice(0, 500) ?? null,
      metadata,
    });

    if (!isSpam) {
      await this.tryNotifyOwner(lead);
    } else {
      this.appLogger.warn('analytics.lead.flagged_spam', {
        leadId: lead.id,
        source: input.source,
      });
    }

    return lead;
  }

  async list(
    filters: ListLeadsFilter,
  ): Promise<{ data: MarketingLead[]; nextCursor: string | null; hasMore: boolean }> {
    return this.repo.listPaginated(filters);
  }

  async findById(id: string): Promise<MarketingLead | null> {
    return this.repo.findById(id);
  }

  async updateStatus(
    id: string,
    status: LeadStatus,
    notes: string | undefined,
    actorUserId: string,
  ): Promise<MarketingLead> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new DomainNotFoundException(RESOURCE, id);

    const now = new Date();
    const patch: Record<string, unknown> = {
      status,
      updatedBy: actorUserId,
    };

    if (status === 'contacted' && !existing.contactedAt) {
      patch.contactedAt = now;
      patch.contactedBy = actorUserId;
    } else if (status === 'demo_scheduled') {
      patch.demoScheduledAt = now;
    } else if (status === 'converted' && !existing.convertedAt) {
      patch.convertedAt = now;
    } else if (status === 'lost') {
      patch.lostAt = now;
      if (notes) patch.lostReason = notes.slice(0, 500);
    }
    if (notes) patch.notes = notes.slice(0, 2000);

    const updated = await this.repo.update(id, patch);

    void this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE,
      resourceId: id,
      tenantId: 'system',
      userId: actorUserId,
      success: true,
      metadata: { fromStatus: existing.status, toStatus: status },
    });

    return updated;
  }

  async convert(leadId: string, tenantId: string, actorUserId: string): Promise<MarketingLead> {
    const existing = await this.repo.findById(leadId);
    if (!existing) throw new DomainNotFoundException(RESOURCE, leadId);

    const updated = await this.repo.update(leadId, {
      status: 'converted',
      convertedAt: new Date(),
      convertedTenantId: tenantId,
      updatedBy: actorUserId,
    });

    void this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: RESOURCE,
      resourceId: leadId,
      tenantId,
      userId: actorUserId,
      success: true,
      metadata: {
        fromStatus: existing.status,
        toStatus: 'converted',
        convertedTenantId: tenantId,
      },
    });

    return updated;
  }

  async getConversionRate(dateRange: DateRange): Promise<ConversionStats> {
    const stats = await this.repo.getConversionStats(dateRange.from, dateRange.to);
    const denom = stats.totalLeads;
    const pct = (n: number): number => (denom > 0 ? Math.round((n / denom) * 10_000) / 100 : 0);
    return {
      ...stats,
      contactRate: pct(stats.contacted),
      qualificationRate: pct(stats.qualified),
      conversionRate: pct(stats.converted),
    };
  }

  /* ────────────────── Internals ────────────────── */

  private async classifySpam(input: CreateLeadInput): Promise<boolean> {
    // Heuristic 1 — disposable / known-spam email domain.
    const domain = input.email.split('@')[1]?.toLowerCase() ?? '';
    if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;

    // Heuristic 2 — spammy phrases in name / message / company.
    const haystack = `${input.name} ${input.message ?? ''} ${input.company ?? ''}`;
    if (SPAM_PATTERNS.some((re) => re.test(haystack))) return true;

    // Heuristic 3 — same email submitted multiple times in 5 minutes.
    const recent = await this.repo.findActiveByEmailRecent(input.email, DUPLICATE_WINDOW_MS);
    if (recent) return true;

    return false;
  }

  private async tryNotifyOwner(lead: MarketingLead): Promise<void> {
    if (!this.notifications) return;
    // OWNER_EMAIL is read from raw env so we don't bind to ConfigService
    // schema (orchestrator may add it later as an optional key).
    const ownerEmail = process.env.OWNER_EMAIL?.trim();
    if (!ownerEmail) {
      this.appLogger.info('analytics.lead.notify.skipped', {
        reason: 'OWNER_EMAIL not set',
        leadId: lead.id,
      });
      return;
    }

    try {
      await this.notifications.send({
        tenantId: 'system',
        userId: lead.createdBy ?? lead.id,
        channels: ['email'],
        category: 'system',
        subject: `New lead: ${lead.name}`,
        body: `A new lead arrived from ${lead.source}.\n\nName: ${lead.name}\nEmail: ${lead.email}${
          lead.mobile ? `\nMobile: ${lead.mobile}` : ''
        }${lead.company ? `\nCompany: ${lead.company}` : ''}`,
        data: {
          template: 'new-lead',
          leadId: lead.id,
          ownerEmail,
        },
        forceSync: false,
      });
    } catch (err) {
      // Notification failure must never break lead capture.
      this.appLogger.error('analytics.lead.notify.failed', {
        leadId: lead.id,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : { name: 'unknown', message: 'unknown' },
      });
    }
  }
}
