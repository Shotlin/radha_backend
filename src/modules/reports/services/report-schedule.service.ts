import { Injectable } from '@nestjs/common';

import { BusinessException, DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { ReportSchedulesRepository } from '../repositories/report-schedules.repository';
import type { ReportSchedule, ScheduleReportParams } from '../types/report.types';
import { computeNextRunAt } from '../utils/schedule.utils';

/**
 * BE-20 — Report scheduling service.
 *
 * Persists user-supplied schedule definitions and computes the
 * `nextRunAt` cursor BE-24's cron job will scan. The actual cron
 * loop lives in BE-24; this service only owns CRUD + cursor math.
 */
@Injectable()
export class ReportScheduleService {
  constructor(
    private readonly schedulesRepo: ReportSchedulesRepository,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
  ) {}

  async create(
    tenantId: string,
    userId: string,
    params: ScheduleReportParams,
  ): Promise<ReportSchedule> {
    const nextRunAt = computeNextRunAt({
      frequency: params.frequency,
      hourOfDay: params.hourOfDay,
      dayOfWeek: params.dayOfWeek,
      dayOfMonth: params.dayOfMonth,
    });
    const created = await this.schedulesRepo.create({
      tenantId,
      storeId: params.storeId,
      type: params.type,
      title: params.title,
      frequency: params.frequency,
      dayOfWeek: params.dayOfWeek ?? null,
      dayOfMonth: params.dayOfMonth ?? null,
      hourOfDay: params.hourOfDay,
      status: 'active',
      parameters: params.parameters as unknown as Record<string, unknown>,
      recipients: params.recipients ?? [],
      nextRunAt,
      createdBy: userId,
    });
    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'ReportSchedule',
      resourceId: created.id,
      userId,
      tenantId,
      success: true,
      metadata: {
        type: created.type,
        frequency: created.frequency,
        nextRunAt: nextRunAt.toISOString(),
      },
    });
    this.logger.info('reports.schedule.created', {
      scheduleId: created.id,
      type: created.type,
      frequency: created.frequency,
    });
    return created;
  }

  async cancel(tenantId: string, userId: string, id: string): Promise<ReportSchedule> {
    const existing = await this.schedulesRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('ReportSchedule', id);
    if (existing.status === 'cancelled') return existing;
    const updated = await this.schedulesRepo.update(id, {
      status: 'cancelled',
      nextRunAt: null,
      updatedBy: userId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ReportSchedule',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'cancel' },
    });
    return updated;
  }

  async pause(tenantId: string, userId: string, id: string): Promise<ReportSchedule> {
    const existing = await this.schedulesRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('ReportSchedule', id);
    if (existing.status === 'cancelled') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot pause a cancelled schedule',
      );
    }
    const updated = await this.schedulesRepo.update(id, {
      status: 'paused',
      updatedBy: userId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ReportSchedule',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'pause' },
    });
    return updated;
  }

  async resume(tenantId: string, userId: string, id: string): Promise<ReportSchedule> {
    const existing = await this.schedulesRepo.findByIdInTenant(id, tenantId);
    if (!existing) throw new DomainNotFoundException('ReportSchedule', id);
    if (existing.status === 'cancelled') {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Cannot resume a cancelled schedule',
      );
    }
    const nextRunAt = computeNextRunAt({
      frequency: existing.frequency,
      hourOfDay: existing.hourOfDay,
      dayOfWeek: existing.dayOfWeek ?? undefined,
      dayOfMonth: existing.dayOfMonth ?? undefined,
    });
    const updated = await this.schedulesRepo.update(id, {
      status: 'active',
      nextRunAt,
      updatedBy: userId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ReportSchedule',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'resume', nextRunAt: nextRunAt.toISOString() },
    });
    return updated;
  }

  async list(tenantId: string, limit = 50): Promise<ReportSchedule[]> {
    return this.schedulesRepo.listForTenant(tenantId, limit);
  }

  async findById(tenantId: string, id: string): Promise<ReportSchedule> {
    const row = await this.schedulesRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('ReportSchedule', id);
    return row;
  }
}
