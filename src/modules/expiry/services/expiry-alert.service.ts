import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Transaction } from '@/db/connection';
import type { ExpiryAlertRow, ExpiryRecordRow } from '@/db/schema/expiry';
import { LoggerService } from '@/logging/logger.service';

import { ExpiryAlertsRepository } from '../repositories/expiry-alerts.repository';
import type { AlertResolution, ExpiryStatus } from '../types/expiry.types';

/**
 * BE-18 — Alert lifecycle service.
 *
 * Generation: `ensureForRecord(record, status, tx)` — idempotent.
 * Pulls the partial unique index `(expiry_record_id, status) WHERE
 * is_resolved = false` to upsert exactly one active alert per record
 * per status. Existing rows are returned untouched.
 *
 * Acknowledge / resolve: standard lifecycle. Resolution carries an
 * enum so reports can pivot on "discounted vs returned vs discarded".
 */
@Injectable()
export class ExpiryAlertService {
  constructor(
    private readonly repo: ExpiryAlertsRepository,
    private readonly logger: LoggerService,
  ) {}

  async ensureForRecord(
    record: ExpiryRecordRow,
    status: Extract<ExpiryStatus, 'yellow' | 'red'>,
    tx?: Transaction,
  ): Promise<ExpiryAlertRow> {
    const existing = await this.repo.findActiveByRecord(record.id, status);
    if (existing) return existing;
    const inserted = await this.repo.insertIfMissing(
      {
        tenantId: record.tenantId,
        storeId: record.storeId,
        expiryRecordId: record.id,
        productId: record.productId,
        status,
        daysRemaining: record.daysRemaining,
        quantity: record.remainingQuantity,
      },
      tx,
    );
    if (inserted) return inserted;
    // Insert was a no-op due to ON CONFLICT — re-read to return.
    const reread = await this.repo.findActiveByRecord(record.id, status);
    if (!reread) {
      throw new BusinessException(
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Failed to ensure alert for record',
        { metadata: { recordId: record.id, status } },
      );
    }
    return reread;
  }

  async acknowledge(
    tenantId: string,
    userId: string,
    alertId: string,
    notes?: string,
  ): Promise<ExpiryAlertRow> {
    const alert = await this.repo.findByIdInTenant(alertId, tenantId);
    if (!alert) throw new DomainNotFoundException('ExpiryAlert', alertId);
    if (alert.isResolved) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot acknowledge a resolved alert',
      );
    }
    return this.repo.update(alertId, {
      isAcknowledged: true,
      acknowledgedBy: userId,
      acknowledgedAt: new Date(),
      acknowledgedNotes: notes ?? null,
    });
  }

  async resolve(
    tenantId: string,
    userId: string,
    alertId: string,
    resolution: AlertResolution,
    notes?: string,
  ): Promise<ExpiryAlertRow> {
    const alert = await this.repo.findByIdInTenant(alertId, tenantId);
    if (!alert) throw new DomainNotFoundException('ExpiryAlert', alertId);
    if (alert.isResolved) return alert;
    const updated = await this.repo.update(alertId, {
      isResolved: true,
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolution,
      acknowledgedNotes: notes ?? alert.acknowledgedNotes,
    });
    return updated;
  }
}
