import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { RecallAlertRow, RecallFeedEntryRow } from '@/db/schema/recall';
import { decodeCursor, encodeCursor } from '@/db/repositories/pagination.utils';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type {
  RecallAlertListResponseDto,
  RecallAlertResponseDto,
  AcknowledgeRecallAlertResponseDto,
} from '../dto/recall.dto';
import { RecallAlertsRepository } from '../repositories/recall-alerts.repository';

/**
 * BE-39 — Read/ack façade for the consumer-facing API surface.
 *
 *   - List alerts (cursor-paginated; consumer sees their own scope
 *     via the `(tenantId, userId)` predicate).
 *   - Acknowledge a single alert (sets `acknowledged_at = now()`).
 *     Cross-tenant or cross-user attempts return 404 — we never leak
 *     existence to the wrong user.
 */
@Injectable()
export class RecallService {
  constructor(
    private readonly alerts: RecallAlertsRepository,
    private readonly logger: LoggerService,
    private readonly auditLog: AuditLogService,
  ) {}

  async listAlerts(
    userId: string,
    tenantId: string,
    filters: { limit?: number; cursor?: string; unacknowledgedOnly?: boolean },
  ): Promise<RecallAlertListResponseDto> {
    const limit = filters.limit ?? 50;
    let cursor: { createdAt: Date; id: string } | undefined;
    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (decoded && typeof decoded.createdAt === 'string' && typeof decoded.id === 'string') {
        cursor = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      }
    }

    const rows = await this.alerts.listForUser(userId, tenantId, {
      limit,
      cursor,
      unacknowledgedOnly: filters.unacknowledgedOnly,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, -1) : rows;

    const nextCursor =
      hasMore && data.length > 0
        ? encodeCursor(
            {
              createdAt: data[data.length - 1].alert.createdAt,
              id: data[data.length - 1].alert.id,
            },
            [
              { field: 'createdAt', direction: 'desc' },
              { field: 'id', direction: 'desc' },
            ],
          )
        : null;

    return {
      data: data.map((r) => this.toView(r.alert, r.feedEntry)),
      nextCursor,
      hasMore,
    };
  }

  async acknowledge(
    userId: string,
    tenantId: string,
    alertId: string,
  ): Promise<AcknowledgeRecallAlertResponseDto> {
    const existing = await this.alerts.findByIdForUser(alertId, userId);
    if (!existing) {
      throw new NotFoundException('Recall alert not found');
    }
    if (existing.tenantId !== tenantId) {
      // The user is authenticated but the alert belongs to a
      // different tenant scope (defence-in-depth — the listing
      // query already enforces this).
      throw new ForbiddenException('Recall alert is out of scope');
    }
    if (existing.acknowledgedAt) {
      // Idempotent: already acknowledged.
      return {
        id: existing.id,
        acknowledgedAt: existing.acknowledgedAt.toISOString(),
      };
    }

    const now = new Date();
    const updated = await this.alerts.acknowledge(alertId, userId, now);
    if (!updated) {
      throw new NotFoundException('Recall alert not found');
    }

    void this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: 'recall_alert',
      resourceId: updated.id,
      tenantId,
      userId,
      success: true,
      metadata: { acknowledgedAt: now.toISOString() },
    });

    return {
      id: updated.id,
      acknowledgedAt: now.toISOString(),
    };
  }

  private toView(alert: RecallAlertRow, feedEntry: RecallFeedEntryRow): RecallAlertResponseDto {
    return {
      id: alert.id,
      acknowledgedAt: alert.acknowledgedAt ? alert.acknowledgedAt.toISOString() : null,
      createdAt: alert.createdAt.toISOString(),
      savedProductId: alert.savedProductId,
      feedEntry: {
        id: feedEntry.id,
        source: feedEntry.source,
        ean: feedEntry.ean,
        brand: feedEntry.brand,
        productName: feedEntry.productName,
        batchNumber: feedEntry.batchNumber,
        reason: feedEntry.reason,
        recalledAt:
          typeof feedEntry.recalledAt === 'string'
            ? feedEntry.recalledAt
            : new Date(feedEntry.recalledAt as unknown as string).toISOString().slice(0, 10),
      },
    };
  }
}
