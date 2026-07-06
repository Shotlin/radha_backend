import { Injectable } from '@nestjs/common';

import {
  BusinessException,
  DomainConflictException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import type { ScanSessionRow } from '@/db/schema/scans';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { CreateSessionDto, EndSessionDto } from '../dto/scans.dto';
import { ScanItemsRepository } from '../repositories/scan-items.repository';
import { ScanSessionsRepository } from '../repositories/scan-sessions.repository';
import type { ScanSessionWithSummary } from '../types/scan.types';

import { ScanSummaryService } from './scan-summary.service';

@Injectable()
export class ScanSessionService {
  /** Sessions inactive for this long are auto-expired by the BE-24 sweep. */
  static readonly INACTIVITY_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

  constructor(
    private readonly db: DbService,
    private readonly sessionsRepo: ScanSessionsRepository,
    private readonly itemsRepo: ScanItemsRepository,
    private readonly summary: ScanSummaryService,
    private readonly audit: AuditLogService,
    private readonly logger: LoggerService,
  ) {}

  async create(tenantId: string, userId: string, dto: CreateSessionDto): Promise<ScanSessionRow> {
    const existing = await this.sessionsRepo.findActiveForUser(userId, dto.storeId, tenantId);
    if (existing) {
      throw new DomainConflictException(
        'Active scan session already exists for this user/store. End it first.',
        ErrorCode.CONFLICT,
        { metadata: { activeSessionId: existing.id } },
      );
    }

    const created = await this.sessionsRepo.create({
      tenantId,
      storeId: dto.storeId,
      userId,
      type: dto.type,
      taskId: dto.taskId,
      eanListId: dto.eanListId,
      startLatitude: dto.startLatitude?.toString(),
      startLongitude: dto.startLongitude?.toString(),
      deviceId: dto.deviceId,
      deviceModel: dto.deviceModel,
      appVersion: dto.appVersion,
      metadata: dto.metadata ?? {},
      status: 'active',
      createdBy: userId,
    });

    await this.audit.logAction({
      action: 'CREATE',
      resourceType: 'ScanSession',
      resourceId: created.id,
      userId,
      tenantId,
      success: true,
      metadata: { type: dto.type, storeId: dto.storeId },
    });
    return created;
  }

  async findById(tenantId: string, id: string): Promise<ScanSessionWithSummary> {
    const row = await this.sessionsRepo.findByIdInTenant(id, tenantId);
    if (!row) throw new DomainNotFoundException('ScanSession', id);
    const summary = await this.summary.forSession(id, tenantId);
    return { ...row, summary };
  }

  async getActive(
    tenantId: string,
    userId: string,
    storeId: string,
  ): Promise<ScanSessionRow | null> {
    return this.sessionsRepo.findActiveForUser(userId, storeId, tenantId);
  }

  async list(
    tenantId: string,
    filters: {
      storeId?: string;
      userId?: string;
      status?: ScanSessionRow['status'];
      type?: ScanSessionRow['type'];
    },
    limit: number,
  ): Promise<ScanSessionRow[]> {
    return this.sessionsRepo.listForTenant(tenantId, filters, limit);
  }

  async end(
    tenantId: string,
    userId: string,
    id: string,
    dto: EndSessionDto,
  ): Promise<ScanSessionRow> {
    const session = await this.sessionsRepo.findByIdInTenant(id, tenantId);
    if (!session) throw new DomainNotFoundException('ScanSession', id);
    if (session.userId !== userId) {
      throw new DomainForbiddenException('Cannot end a session belonging to another user');
    }
    if (session.status !== 'active') {
      throw new BusinessException(
        ErrorCode.SCAN_SESSION_CLOSED,
        `Session is already in status '${session.status}'`,
      );
    }

    const endedAt = new Date();
    const durationSeconds = Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1000);

    return this.db.transaction(async (tx) => {
      // Refresh denormalised counters from the canonical items aggregate.
      const aggregate = await this.itemsRepo.aggregateForSession(id);
      const updated = await this.sessionsRepo.update(
        id,
        {
          status: 'completed',
          endedAt,
          durationSeconds,
          totalScans: aggregate.totalScans,
          uniqueProducts: aggregate.uniqueProducts,
          matchedEans: aggregate.matchedEans,
          unmatchedEans: aggregate.unmatchedEans,
          expiredItems: aggregate.expiredItems,
          nearExpiryItems: aggregate.nearExpiryItems,
          metadata: dto.notes
            ? { ...(session.metadata as Record<string, unknown>), endNotes: dto.notes }
            : session.metadata,
          updatedBy: userId,
        },
        tx,
      );

      await this.audit.logAction({
        action: 'UPDATE',
        resourceType: 'ScanSession',
        resourceId: id,
        userId,
        tenantId,
        success: true,
        metadata: {
          transition: 'complete',
          durationSeconds,
          totalScans: aggregate.totalScans,
        },
      });
      return updated;
    });
  }

  async abandon(tenantId: string, userId: string, id: string): Promise<ScanSessionRow> {
    const session = await this.sessionsRepo.findByIdInTenant(id, tenantId);
    if (!session) throw new DomainNotFoundException('ScanSession', id);
    if (session.userId !== userId) {
      throw new DomainForbiddenException('Cannot abandon a session belonging to another user');
    }
    if (session.status !== 'active') return session;

    const updated = await this.sessionsRepo.update(id, {
      status: 'abandoned',
      endedAt: new Date(),
      updatedBy: userId,
    });
    await this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'ScanSession',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { transition: 'abandon' },
    });
    return updated;
  }

  async getDailyStats(tenantId: string, storeId: string, date: Date) {
    return this.sessionsRepo.getDailyStats(storeId, tenantId, date);
  }

  /**
   * BE-24 cron sweep — auto-expire active sessions whose
   * `lastActivityAt` is older than the inactivity threshold.
   */
  async expireStaleSessions(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ScanSessionService.INACTIVITY_TIMEOUT_MS);
    const stale = await this.sessionsRepo.findStaleActive(cutoff, 200);
    if (stale.length === 0) return 0;
    let count = 0;
    for (const session of stale) {
      try {
        const aggregate = await this.itemsRepo.aggregateForSession(session.id);
        await this.sessionsRepo.update(session.id, {
          status: 'expired',
          endedAt: now,
          durationSeconds: Math.floor((now.getTime() - session.startedAt.getTime()) / 1000),
          totalScans: aggregate.totalScans,
          uniqueProducts: aggregate.uniqueProducts,
          matchedEans: aggregate.matchedEans,
          unmatchedEans: aggregate.unmatchedEans,
          expiredItems: aggregate.expiredItems,
          nearExpiryItems: aggregate.nearExpiryItems,
        });
        count++;
      } catch (err) {
        this.logger.warn('scan.session.expire_failed', {
          sessionId: session.id,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }
    this.logger.info('scan.session.expired_swept', { count });
    return count;
  }
}
