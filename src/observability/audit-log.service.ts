import { Inject, Injectable, Optional } from '@nestjs/common';

import { RequestContextService } from '@/common/context/request-context.service';
import { redactPII } from '@/common/utils/redact.utils';
import { ConfigService } from '@/config/config.service';
import { AuditLogRepository } from '@/db/repositories/audit-log.repository';
import { LoggerService } from '@/logging/logger.service';

import { AuditEntry, AuditQueryFilters, IAuditLogService } from './audit-log.types';

/**
 * Records security- and compliance-relevant actions.
 *
 *   BE-04: structured-log only (`audit: true` tag).
 *   BE-05: also persists to the `audit_logs` table when the
 *          `AuditLogRepository` is available — the repository is
 *          injected with `@Optional()` so the service still works in
 *          tests / processes that boot without the database.
 */
@Injectable()
export class AuditLogService implements IAuditLogService {
  constructor(
    private readonly logger: LoggerService,
    private readonly context: RequestContextService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(AuditLogRepository)
    private readonly repo?: AuditLogRepository,
  ) {}

  async logAction(entry: AuditEntry): Promise<void> {
    if (!this.config.observability.auditLogEnabled) return;

    const enriched: AuditEntry = {
      ...entry,
      userId: entry.userId || this.context.getUserId() || 'system',
      tenantId: entry.tenantId || this.context.getTenantId() || 'system',
      ipAddress: entry.ipAddress ?? this.context.get('ipAddress'),
      userAgent: entry.userAgent ?? this.context.get('userAgent'),
      timestamp: entry.timestamp ?? new Date(),
      metadata: entry.metadata ? (redactPII(entry.metadata) as Record<string, unknown>) : undefined,
    };

    this.logger.info('audit.event', { audit: true, ...enriched });

    if (this.repo) {
      try {
        await this.repo.create({
          action: enriched.action,
          resourceType: enriched.resourceType,
          resourceId: enriched.resourceId,
          userId: enriched.userId === 'system' ? null : enriched.userId,
          tenantId: enriched.tenantId === 'system' ? null : enriched.tenantId,
          metadata: enriched.metadata,
          ipAddress: enriched.ipAddress,
          userAgent: enriched.userAgent,
          success: enriched.success,
          errorCode: enriched.errorCode,
          occurredAt: enriched.timestamp,
        });
      } catch (err) {
        // Audit-log persistence failure must never break the user's
        // request; it's already in the structured logs as a fallback.
        this.logger.error('audit.persist.failed', {
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }
  }

  async logBatch(entries: AuditEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.logAction(entry);
    }
  }

  async query(_filters: AuditQueryFilters): Promise<AuditEntry[]> {
    // Admin-facing query endpoints land in BE-31 (App Owner Dashboard).
    return [];
  }
}
